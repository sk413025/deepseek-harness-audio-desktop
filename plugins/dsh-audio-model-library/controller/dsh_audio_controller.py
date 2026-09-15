#!/usr/bin/env python3
"""dsh-audio-controller: a narrow model-service switch for one GPU server.

Proposal source from the Harness model-library lane. The DGX/GPU owner reviews, deploys and
activates it; nothing here runs on a server until that owner installs it.

Safety model
  * Only recipe IDs listed in the owner's recipes.json can be started or stopped. Every docker
    invocation is a fixed argv built from that file (no shell, no client-supplied text).
  * Clients reach it through an existing authenticated channel only:
      - SSH forced command (`command="... --ssh",restrict` in authorized_keys), or
      - `serve`: HTTP bound to loopback/private address with a bearer token file (0600).
    It refuses to bind 0.0.0.0/::.
  * A transition is refused while the GPU owner lock is not delegated to the controller, during a
    measurement reservation, while a foreign GPU workload runs, or while model ports still carry
    established client connections after a bounded drain (an audio turn in progress).
  * One transition at a time (file lock). A failed load stops the target and restores the
    previously active recipe when the policy says so.

Protocol: dsh.audio-controller/0.1 (see CONTROLLER_PROTOCOL.md next to this file).
Python 3.10+ standard library only.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import hmac
import ipaddress
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROTOCOL = "dsh.audio-controller/0.1"
VERSION = "0.1.0"

RECIPE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
JOB_ID = re.compile(r"^job-[0-9a-f]{16}$")
TOKEN = re.compile(r"^[A-Za-z0-9._:@-]{1,64}$")
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
SECRETISH = re.compile(r"(hf_[A-Za-z0-9]{8,}|Bearer\s+\S+|(?i:token|password|secret)=\S+)")

TERMINAL = {"ready", "stopped", "failed", "cancelled", "refused"}
ACTIVE_PHASES = ["queued", "preflight", "draining", "stopping", "starting", "loading", "verifying", "restoring"]


class ControllerError(Exception):
    def __init__(self, code: str, message: str, status: int = 409, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra

    def body(self) -> dict[str, Any]:
        return {"ok": False, "error": {"code": self.code, "message": self.message, **self.extra}}


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def parse_time(text: Any) -> float | None:
    if not isinstance(text, str) or text == "":
        return None
    try:
        return _dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def scrub(text: str, limit: int = 4000) -> str:
    text = SECRETISH.sub("[redacted]", text)
    return text[-limit:]


# --------------------------------------------------------------------------- configuration


class Config:
    """Owner-written configuration: controller.json (policy/paths) + recipes.json (allowlist)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        raw = json.loads(path.read_text(encoding="utf-8"))
        base = path.parent
        if raw.get("protocol") != PROTOCOL:
            raise SystemExit(f"{path}: protocol must be {PROTOCOL}")
        self.server_id: str = raw.get("serverId", "gpu-server")
        if not TOKEN.match(self.server_id):
            raise SystemExit("serverId must match " + TOKEN.pattern)
        self.state_dir = (base / raw.get("stateDir", "../state")).resolve()
        self.recipes_file = (base / raw.get("recipesFile", "recipes.json")).resolve()
        catalog = raw.get("catalogFile")
        self.catalog_file = (base / catalog).resolve() if catalog else None
        self.docker = raw.get("dockerBinary", "/usr/bin/docker")
        self.ss = raw.get("ssBinary", "/usr/bin/ss")
        for binary in (self.docker, self.ss):
            if not os.path.isabs(binary):
                raise SystemExit("dockerBinary/ssBinary must be absolute paths")
        policy = raw.get("policy", {})
        self.exclusive_gpu = bool(policy.get("exclusiveGpu", True))
        lock = policy.get("gpuOwnerLock") or {}
        self.owner_lock_path = Path(lock["path"]) if lock.get("path") else None
        self.owner_lock_delegation = str(lock.get("delegationLine", "controller=allow"))
        self.reservation_path = Path(policy["reservationFile"]) if policy.get("reservationFile") else None
        self.foreign_prefixes = [str(p) for p in policy.get("foreignContainerPrefixes", [])]
        self.drain_seconds = float(policy.get("drainSeconds", 20))
        self.restore_previous = bool(policy.get("restorePreviousOnFailure", True))
        self.health_host = str(policy.get("healthHost", "127.0.0.1"))
        http = raw.get("http", {})
        self.http_bind = str(http.get("bind", "127.0.0.1:18190"))
        self.http_token_file = (base / http["tokenFile"]).resolve() if http.get("tokenFile") else None
        self.recipes = self._load_recipes()

    def _load_recipes(self) -> dict[str, dict[str, Any]]:
        data = json.loads(self.recipes_file.read_text(encoding="utf-8"))
        recipes: dict[str, dict[str, Any]] = {}
        ports: dict[int, str] = {}
        for recipe in data.get("recipes", []):
            rid = recipe.get("id", "")
            if not RECIPE_ID.match(rid):
                raise SystemExit(f"recipe id {rid!r} is invalid")
            if rid in recipes:
                raise SystemExit(f"duplicate recipe {rid}")
            compose = recipe.get("compose") or {}
            for key in ("projectDirectory", "project", "service"):
                if not isinstance(compose.get(key), str) or compose[key] == "":
                    raise SystemExit(f"recipe {rid}: compose.{key} is required")
            if not os.path.isabs(compose["projectDirectory"]):
                raise SystemExit(f"recipe {rid}: compose.projectDirectory must be absolute")
            if not CONTAINER.match(str(recipe.get("container", ""))):
                raise SystemExit(f"recipe {rid}: container name is invalid")
            port = recipe.get("port")
            if not isinstance(port, int) or not (1 <= port <= 65535):
                raise SystemExit(f"recipe {rid}: port is invalid")
            for key in (compose.get("env") or {}):
                if not ENV_KEY.match(key) or "\n" in str(compose["env"][key]):
                    raise SystemExit(f"recipe {rid}: env {key!r} is invalid")
            if port in ports and ports[port] != recipe["container"]:
                # Two recipes may share a port only if they are mutually exclusive services.
                recipe.setdefault("_sharedPortWith", ports[port])
            ports[port] = recipe["container"]
            recipes[rid] = recipe
        return recipes

    def recipe(self, rid: str) -> dict[str, Any]:
        if not RECIPE_ID.match(rid or ""):
            raise ControllerError("BAD_REQUEST", "recipe id is invalid", 400)
        recipe = self.recipes.get(rid)
        if recipe is None:
            raise ControllerError("UNKNOWN_RECIPE", f"recipe {rid} is not allowlisted on this server", 404)
        return recipe


def public_recipe(recipe: dict[str, Any]) -> dict[str, Any]:
    """Fields safe to show to clients (no host paths, no env values)."""
    keys = ["id", "displayName", "catalogIds", "runtime", "port", "endpoints", "servedModels",
            "typicalLoadSeconds", "startTimeoutSeconds", "memoryGiB", "tasks", "notes"]
    return {k: recipe[k] for k in keys if k in recipe}


# --------------------------------------------------------------------------- system probes


class System:
    def __init__(self, config: Config) -> None:
        self.config = config

    def run(self, argv: list[str], timeout: float, env: dict[str, str] | None = None, cwd: str | None = None) -> subprocess.CompletedProcess[str]:
        merged = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        if "HOME" in os.environ:
            merged["HOME"] = os.environ["HOME"]
        if "DOCKER_HOST" in os.environ:
            merged["DOCKER_HOST"] = os.environ["DOCKER_HOST"]
        merged.update(env or {})
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=merged, cwd=cwd, check=False)

    def containers(self) -> dict[str, str]:
        """Running container name → status text."""
        proc = self.run([self.config.docker, "ps", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"], timeout=30)
        if proc.returncode != 0:
            raise ControllerError("DOCKER_UNAVAILABLE", scrub(proc.stderr or "docker ps failed", 400), 503)
        out: dict[str, str] = {}
        for line in proc.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2 and parts[1] == "running":
                out[parts[0]] = parts[2] if len(parts) > 2 else "running"
        return out

    def established(self, port: int) -> int:
        proc = self.run([self.config.ss, "-Htn", "state", "established", f"( sport = :{port} )"], timeout=10)
        if proc.returncode != 0:
            raise ControllerError("BUSY_CHECK_FAILED", scrub(proc.stderr or "ss failed", 400), 503)
        return sum(1 for line in proc.stdout.splitlines() if line.strip())

    def http_get(self, port: int, path: str, timeout: float = 5) -> tuple[int, bytes]:
        url = f"http://{self.config.health_host}:{port}{path}"
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 (fixed loopback URL)
                return response.status, response.read(1 << 20)
        except urllib.error.HTTPError as error:
            return error.code, b""
        except (urllib.error.URLError, OSError, TimeoutError):
            return 0, b""

    def compose(self, recipe: dict[str, Any], *args: str, timeout: float) -> subprocess.CompletedProcess[str]:
        c = recipe["compose"]
        argv = [self.config.docker, "compose", "--project-directory", c["projectDirectory"], "-p", c["project"]]
        for file in c.get("files", []):
            argv += ["-f", os.path.join(c["projectDirectory"], file)]
        if c.get("envFile"):
            argv += ["--env-file", os.path.join(c["projectDirectory"], c["envFile"])]
        if c.get("profile"):
            argv += ["--profile", c["profile"]]
        argv += list(args)
        env = {k: str(v) for k, v in (c.get("env") or {}).items()}
        return self.run(argv, timeout=timeout, env=env, cwd=c["projectDirectory"])


# --------------------------------------------------------------------------- policy


def owner_lock_state(config: Config) -> dict[str, Any]:
    path = config.owner_lock_path
    if path is None or not path.exists():
        return {"present": False, "delegated": True}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        return {"present": True, "delegated": False, "owner": None, "error": str(error)}
    owner = next((line.split("=", 1)[1].strip() for line in text.splitlines() if line.startswith("owner=")), None)
    delegated = any(line.strip() == config.owner_lock_delegation for line in text.splitlines())
    return {"present": True, "delegated": delegated, "owner": (owner or "")[:120] or None}


def reservation_state(config: Config, now: float | None = None) -> dict[str, Any]:
    path = config.reservation_path
    now = time.time() if now is None else now
    if path is None or not path.exists():
        return {"state": "open", "source": "none"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return {"state": "unreadable", "error": str(error)[:200]}
    state = data.get("state", "open")
    until = parse_time(data.get("until"))
    if until is not None and until <= now:
        return {"state": "open", "source": "expired", "expiredAt": data.get("until")}
    return {
        "state": state if state in {"open", "measurement", "integration", "maintenance"} else "unreadable",
        "until": data.get("until"),
        "owner": str(data.get("owner", ""))[:120] or None,
        "allowRecipes": [r for r in data.get("allowRecipes", []) if isinstance(r, str)],
        "label": str(data.get("label", ""))[:120] or None,
    }


def switching_verdict(config: Config, target: str | None, active: list[str]) -> dict[str, Any]:
    lock = owner_lock_state(config)
    reservation = reservation_state(config)
    if lock["present"] and not lock["delegated"]:
        return {"allowed": False, "code": "GPU_OWNER_LOCKED", "reason": f"GPU owner lock held by {lock.get('owner') or 'another owner'} without controller delegation", "lock": lock, "reservation": reservation}
    state = reservation["state"]
    if state == "unreadable":
        return {"allowed": False, "code": "RESERVATION_UNREADABLE", "reason": "reservation file cannot be read; refusing to switch", "lock": lock, "reservation": reservation}
    if state in {"measurement", "maintenance"}:
        return {"allowed": False, "code": "RESERVED_MEASUREMENT", "reason": f"{state} reservation until {reservation.get('until') or 'further notice'}", "lock": lock, "reservation": reservation}
    if state == "integration":
        allow = reservation.get("allowRecipes") or []
        if target is not None and (target not in allow or any(r not in allow for r in active if r != target)):
            return {"allowed": False, "code": "RESERVED_INTEGRATION", "reason": "integration window: only its listed recipes may be active", "lock": lock, "reservation": reservation}
    return {"allowed": True, "code": None, "reason": None, "lock": lock, "reservation": reservation}


# --------------------------------------------------------------------------- controller


class Controller:
    def __init__(self, config: Config, system: System | None = None) -> None:
        self.config = config
        self.system = system or System(config)
        self.jobs_dir = config.state_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(config.state_dir, 0o700)

    # ---- audit / jobs
    def audit(self, entry: dict[str, Any]) -> None:
        entry = {"at": now_iso(), **entry}
        with open(self.config.state_dir / "audit.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")

    def job_path(self, job_id: str) -> Path:
        if not JOB_ID.match(job_id or ""):
            raise ControllerError("BAD_REQUEST", "job id is invalid", 400)
        return self.jobs_dir / f"{job_id}.json"

    def cancel_path(self, job_id: str) -> Path:
        return self.job_path(job_id).with_suffix(".cancel")

    def read_job(self, job_id: str) -> dict[str, Any]:
        path = self.job_path(job_id)
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ControllerError("UNKNOWN_JOB", f"job {job_id} not found", 404) from None
        job["cancelRequested"] = self.cancel_path(job_id).exists()
        return job

    def write_job(self, job: dict[str, Any]) -> None:
        job["updatedAt"] = now_iso()
        atomic_write_json(self.job_path(job["jobId"]), job)

    def current_job(self) -> dict[str, Any] | None:
        pointer = self.config.state_dir / "current-job"
        if not pointer.exists():
            return None
        job_id = pointer.read_text(encoding="utf-8").strip()
        try:
            job = self.read_job(job_id)
        except ControllerError:
            return None
        if job.get("phase") in TERMINAL:
            return job
        # A worker that died leaves a non-terminal job without its lock: mark it failed. A freshly
        # queued job may not have taken the lock yet, so allow its worker a short start-up grace.
        updated = parse_time(job.get("updatedAt")) or 0
        if time.time() - updated > 30 and not self._transition_locked():
            job.update(phase="failed", error={"code": "WORKER_LOST", "message": "controller worker exited before finishing"})
            self.write_job(job)
        return job

    def _transition_locked(self) -> bool:
        path = self.config.state_dir / "transition.lock"
        with open(path, "a+") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(handle, fcntl.LOCK_UN)
            return False

    # ---- read-only views
    def active(self) -> list[dict[str, Any]]:
        running = self.system.containers()
        out = []
        for rid, recipe in self.config.recipes.items():
            if recipe["container"] in running:
                out.append({"recipeId": rid, "container": recipe["container"], "status": running[recipe["container"]], "port": recipe["port"]})
        return out

    def foreign(self, running: dict[str, str]) -> list[str]:
        managed = {r["container"] for r in self.config.recipes.values()}
        return sorted(name for name in running if name not in managed and any(name.startswith(p) for p in self.config.foreign_prefixes))

    def health(self, rid: str) -> dict[str, Any]:
        recipe = self.config.recipe(rid)
        status, _ = self.system.http_get(recipe["port"], recipe.get("healthPath", "/health"))
        listed: list[str] = []
        if status == 200:
            code, body = self.system.http_get(recipe["port"], recipe.get("modelsPath", "/v1/models"))
            if code == 200:
                try:
                    listed = [str(m.get("id")) for m in json.loads(body).get("data", [])]
                except (ValueError, AttributeError):
                    listed = []
        expected = recipe.get("servedModels", [])
        return {"recipeId": rid, "healthy": status == 200, "healthStatus": status, "listedModels": listed,
                "modelsListed": bool(expected) and all(m in listed for m in expected)}

    def status(self) -> dict[str, Any]:
        running = self.system.containers()
        active = []
        for rid, recipe in self.config.recipes.items():
            if recipe["container"] in running:
                h = self.health(rid)
                active.append({"recipeId": rid, "port": recipe["port"], "containerStatus": running[recipe["container"]],
                               "healthy": h["healthy"], "modelsListed": h["modelsListed"], "servedModels": recipe.get("servedModels", [])})
        verdict = switching_verdict(self.config, None, [a["recipeId"] for a in active])
        return {"ok": True, "protocol": PROTOCOL, "controller": {"version": VERSION, "serverId": self.config.server_id},
                "time": now_iso(), "active": active, "foreignWorkloads": self.foreign(running),
                "switching": {"allowed": verdict["allowed"] and not self.foreign(running), "code": verdict["code"] or ("FOREIGN_GPU_WORKLOAD" if self.foreign(running) else None),
                              "reason": verdict["reason"], "reservation": verdict["reservation"], "ownerLock": verdict["lock"]},
                "job": self.current_job()}

    def recipes(self) -> dict[str, Any]:
        return {"ok": True, "protocol": PROTOCOL, "serverId": self.config.server_id,
                "recipes": [public_recipe(r) for r in self.config.recipes.values()]}

    def catalog(self) -> dict[str, Any]:
        if self.config.catalog_file is None or not self.config.catalog_file.exists():
            return {"ok": True, "protocol": PROTOCOL, "catalog": None}
        data = json.loads(self.config.catalog_file.read_text(encoding="utf-8"))
        return {"ok": True, "protocol": PROTOCOL, "catalog": data}

    # ---- transitions
    def submit(self, kind: str, rid: str, request_id: str | None, client_id: str | None, via: str, spawn: bool = True) -> dict[str, Any]:
        if kind not in {"activate", "deactivate"}:
            raise ControllerError("BAD_REQUEST", "unknown transition", 400)
        self.config.recipe(rid)
        for label, value in (("request", request_id), ("client", client_id)):
            if value is not None and not TOKEN.match(value):
                raise ControllerError("BAD_REQUEST", f"{label} id is invalid", 400)
        current = self.current_job()
        if current is not None and current.get("phase") not in TERMINAL:
            if current.get("kind") == kind and current.get("recipeId") == rid:
                return {"ok": True, "job": current, "deduplicated": True}
            raise ControllerError("JOB_IN_PROGRESS", f"another transition is running ({current.get('kind')} {current.get('recipeId')})", 409, job=current)
        if current is not None and request_id is not None and current.get("requestId") == request_id and current.get("recipeId") == rid and current.get("kind") == kind:
            return {"ok": True, "job": current, "deduplicated": True}
        # Cheap synchronous refusal for the common cases; the worker re-checks under the lock.
        active_ids = [a["recipeId"] for a in self.active()] if kind == "activate" else []
        verdict = switching_verdict(self.config, rid if kind == "activate" else None, active_ids)
        if not verdict["allowed"]:
            self.audit({"via": via, "client": client_id, "request": request_id, "command": kind, "recipe": rid, "result": verdict["code"]})
            raise ControllerError(verdict["code"], verdict["reason"], 409, reservation=verdict["reservation"])
        job = {"jobId": f"job-{secrets.token_hex(8)}", "kind": kind, "recipeId": rid, "requestId": request_id, "clientId": client_id,
               "via": via, "phase": "queued", "createdAt": now_iso(), "history": [{"phase": "queued", "at": now_iso()}],
               "previous": active_ids, "typicalLoadSeconds": self.config.recipes[rid].get("typicalLoadSeconds"),
               "cancelRequested": False, "error": None, "restored": None}
        self.write_job(job)
        (self.config.state_dir / "current-job").write_text(job["jobId"] + "\n", encoding="utf-8")
        self.audit({"via": via, "client": client_id, "request": request_id, "command": kind, "recipe": rid, "job": job["jobId"], "result": "queued"})
        if spawn:
            subprocess.Popen(  # noqa: S603 (fixed argv: this script + validated job id)
                [sys.executable, os.path.abspath(__file__), "--config", str(self.config.path), "_worker", job["jobId"]],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        return {"ok": True, "job": job}

    def cancel(self, job_id: str, via: str) -> dict[str, Any]:
        job = self.read_job(job_id)
        if job.get("phase") in TERMINAL:
            return {"ok": True, "job": job}
        # A separate marker file: the worker rewrites the job file and must not lose the request.
        self.cancel_path(job_id).write_text(now_iso() + "\n", encoding="utf-8")
        job["cancelRequested"] = True
        self.audit({"via": via, "command": "cancel", "job": job_id, "result": "requested"})
        return {"ok": True, "job": job}

    def run_worker(self, job_id: str, sleep: Any = time.sleep) -> dict[str, Any]:
        lock_path = self.config.state_dir / "transition.lock"
        with open(lock_path, "a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                job = self.read_job(job_id)
                job.update(phase="refused", error={"code": "JOB_IN_PROGRESS", "message": "another worker holds the transition lock"})
                self.write_job(job)
                return job
            return Worker(self, job_id, sleep).run()


def up_args(recipe: dict[str, Any]) -> list[str]:
    """`compose up` argv for one recipe: never builds; pulls only when the recipe allows; `noDeps` keeps
    depends_on services (e.g. a second GPU model) from starting alongside the target."""
    pull = recipe.get("pull", "never")
    if pull not in {"never", "missing"}:
        raise ControllerError("BAD_RECIPE", f"recipe {recipe['id']}: pull must be never or missing", 500)
    args = ["up", "-d", "--no-build", "--pull", pull]
    if recipe.get("noDeps") is True:
        args.append("--no-deps")
    return args + [recipe["compose"]["service"]]


class Cancelled(Exception):
    pass


class Worker:
    def __init__(self, controller: Controller, job_id: str, sleep: Any) -> None:
        self.c = controller
        self.config = controller.config
        self.system = controller.system
        self.job = controller.read_job(job_id)
        self.sleep = sleep
        self.started_target = False
        self.stopped_previous = False

    def phase(self, name: str, detail: Any = None) -> None:
        self.job["cancelRequested"] = self.c.cancel_path(self.job["jobId"]).exists()
        self.job["phase"] = name
        self.job["phaseStartedAt"] = now_iso()
        entry = {"phase": name, "at": now_iso()}
        if detail is not None:
            entry["detail"] = detail
        self.job["history"].append(entry)
        self.c.write_job(self.job)

    def check_cancel(self) -> None:
        if self.c.cancel_path(self.job["jobId"]).exists():
            self.job["cancelRequested"] = True
            raise Cancelled()

    def run(self) -> dict[str, Any]:
        rid = self.job["recipeId"]
        recipe = self.config.recipe(rid)
        try:
            if self.job["kind"] == "deactivate":
                self.preflight(rid, activating=False)
                self.drain([recipe])
                self.phase("stopping", {"recipes": [rid]})
                self.stop(recipe)
                self.finish("stopped")
                return self.job
            running_before = self.preflight(rid, activating=True)
            already = rid in running_before
            if already:
                self.phase("verifying")
                if self.wait_ready(recipe, timeout=60):
                    self.finish("ready", {"alreadyActive": True})
                    return self.job
            others = [self.config.recipes[r] for r in running_before if r != rid]
            if self.config.exclusive_gpu and others:
                self.drain(others)
                self.check_cancel()
                self.phase("stopping", {"recipes": [r["id"] for r in others]})
                self.stopped_previous = True
                for other in others:
                    self.stop(other)
            self.check_cancel()
            self.phase("starting")
            proc = self.system.compose(recipe, *up_args(recipe), timeout=600)
            self.started_target = True
            if proc.returncode != 0:
                raise ControllerError("START_FAILED", scrub(proc.stderr or proc.stdout or "compose up failed", 1200))
            self.phase("loading", {"typicalLoadSeconds": recipe.get("typicalLoadSeconds")})
            if not self.wait_ready(recipe, timeout=float(recipe.get("startTimeoutSeconds", 1800)), cancellable=True):
                raise ControllerError("HEALTH_TIMEOUT", f"{rid} did not become healthy with its served models listed")
            self.finish("ready")
        except Cancelled:
            self.recover("cancelled", {"code": "CANCELLED", "message": "cancelled by client"})
        except ControllerError as error:
            if error.code in {"GPU_OWNER_LOCKED", "RESERVED_MEASUREMENT", "RESERVED_INTEGRATION", "RESERVATION_UNREADABLE", "MODEL_BUSY", "FOREIGN_GPU_WORKLOAD"} and not self.started_target and self.job["phase"] in {"preflight", "draining"}:
                self.finish("refused", None, {"code": error.code, "message": error.message, **error.extra})
            else:
                self.recover("failed", {"code": error.code, "message": error.message, **error.extra})
        except Exception as error:  # noqa: BLE001 (report every worker failure in the job)
            self.recover("failed", {"code": "INTERNAL", "message": scrub(repr(error), 400)})
        return self.job

    def preflight(self, rid: str, activating: bool) -> list[str]:
        self.phase("preflight")
        running = self.system.containers()
        active = [r for r, recipe in self.config.recipes.items() if recipe["container"] in running]
        verdict = switching_verdict(self.config, rid if activating else None, active)
        if not verdict["allowed"]:
            raise ControllerError(verdict["code"], verdict["reason"], reservation=verdict["reservation"])
        foreign = self.c.foreign(running)
        if activating and self.config.exclusive_gpu and foreign:
            raise ControllerError("FOREIGN_GPU_WORKLOAD", "an unmanaged GPU workload is running", foreign=foreign)
        return active

    def drain(self, recipes: list[dict[str, Any]]) -> None:
        self.phase("draining", {"ports": [r["port"] for r in recipes], "drainSeconds": self.config.drain_seconds})
        deadline = time.monotonic() + self.config.drain_seconds
        while True:
            counts = {r["id"]: self.system.established(r["port"]) for r in recipes}
            if all(v == 0 for v in counts.values()):
                return
            if time.monotonic() >= deadline:
                raise ControllerError("MODEL_BUSY", "model port still has established client connections (a turn or live session may be running)", connections=counts)
            self.check_cancel()
            self.sleep(1)

    def stop(self, recipe: dict[str, Any]) -> None:
        proc = self.system.compose(recipe, "stop", "-t", str(int(recipe.get("stopTimeoutSeconds", 90))), recipe["compose"]["service"], timeout=float(recipe.get("stopTimeoutSeconds", 90)) + 60)
        if proc.returncode != 0:
            raise ControllerError("STOP_FAILED", scrub(proc.stderr or proc.stdout or "compose stop failed", 1200), recipe=recipe["id"])

    def wait_ready(self, recipe: dict[str, Any], timeout: float, cancellable: bool = False) -> bool:
        deadline = time.monotonic() + timeout
        last: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if cancellable:
                self.check_cancel()
            running = self.system.containers()
            if recipe["container"] not in running and self.started_target:
                raise ControllerError("CONTAINER_EXITED", f"{recipe['container']} exited during load", logTail=self.log_tail(recipe))
            health = self.c.health(recipe["id"])
            if health != last:
                self.job["health"] = health
                self.c.write_job(self.job)
                last = health
            if health["healthy"] and health["modelsListed"]:
                if self.job["phase"] == "loading":
                    self.phase("verifying")
                return True
            self.sleep(2)
        return False

    def log_tail(self, recipe: dict[str, Any]) -> str:
        try:
            proc = self.system.compose(recipe, "logs", "--no-color", "--tail", "40", recipe["compose"]["service"], timeout=30)
            return scrub(proc.stdout + proc.stderr, 3000)
        except (subprocess.TimeoutExpired, OSError):
            return ""

    def recover(self, terminal: str, error: dict[str, Any]) -> None:
        rid = self.job["recipeId"]
        recipe = self.config.recipes[rid]
        if self.started_target:
            if "logTail" not in error:
                error["logTail"] = self.log_tail(recipe)
            try:
                self.stop(recipe)
            except ControllerError as stop_error:
                error["stopError"] = stop_error.message
        restored = None
        previous = [p for p in self.job.get("previous", []) if p != rid and p in self.config.recipes]
        if self.job["kind"] == "activate" and self.config.restore_previous and previous and self.stopped_previous:
            self.phase("restoring", {"recipes": previous})
            restored = []
            for pid in previous:
                prior = self.config.recipes[pid]
                proc = self.system.compose(prior, *up_args(prior), timeout=600)
                ok = proc.returncode == 0
                if ok:
                    self.started_target = False
                    try:
                        ok = self.wait_ready(prior, timeout=float(prior.get("startTimeoutSeconds", 1800)))
                    except ControllerError:
                        ok = False
                restored.append({"recipeId": pid, "ok": ok})
        self.finish(terminal, None, error, restored)

    def finish(self, terminal: str, detail: Any = None, error: dict[str, Any] | None = None, restored: Any = None) -> None:
        self.phase(terminal, detail)
        self.job["error"] = error
        self.job["restored"] = restored
        self.job["finishedAt"] = now_iso()
        self.c.write_job(self.job)
        self.c.audit({"via": "worker", "command": self.job["kind"], "recipe": self.job["recipeId"], "job": self.job["jobId"],
                      "result": terminal, "error": (error or {}).get("code")})


# --------------------------------------------------------------------------- front ends


def dispatch(controller: Controller, argv: list[str], via: str) -> tuple[int, dict[str, Any]]:
    """Parse one client command (already split into tokens)."""
    if not argv:
        raise ControllerError("BAD_REQUEST", "missing command", 400)
    if argv[0] in {"dsh-audio-ctl", "dsh_audio_controller.py"}:
        argv = argv[1:]
    if not argv:
        raise ControllerError("BAD_REQUEST", "missing command", 400)
    command, rest = argv[0], argv[1:]
    options: dict[str, str] = {}
    positional: list[str] = []
    i = 0
    while i < len(rest):
        token = rest[i]
        if token in {"--request", "--client"}:
            if i + 1 >= len(rest) or not TOKEN.match(rest[i + 1]):
                raise ControllerError("BAD_REQUEST", f"{token} needs a valid id", 400)
            options[token[2:]] = rest[i + 1]
            i += 2
            continue
        if not TOKEN.match(token):
            raise ControllerError("BAD_REQUEST", "argument contains unsupported characters", 400)
        positional.append(token)
        i += 1
    if command == "version" and not positional:
        return 0, {"ok": True, "protocol": PROTOCOL, "version": VERSION}
    if command == "status" and not positional:
        return 0, controller.status()
    if command == "recipes" and not positional:
        return 0, controller.recipes()
    if command == "catalog" and not positional:
        return 0, controller.catalog()
    if command in {"activate", "deactivate"} and len(positional) == 1:
        return 0, controller.submit(command, positional[0], options.get("request"), options.get("client"), via)
    if command == "job" and len(positional) == 1:
        return 0, {"ok": True, "job": controller.read_job(positional[0])}
    if command == "cancel" and len(positional) == 1:
        return 0, controller.cancel(positional[0], via)
    if command == "health" and len(positional) == 1:
        return 0, {"ok": True, **controller.health(positional[0])}
    raise ControllerError("BAD_REQUEST", f"unsupported command {command!r}", 400)


def emit(body: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(body, sort_keys=True) + "\n")
    sys.stdout.flush()


def ssh_main(controller: Controller) -> int:
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if len(original) > 512 or any(ch in original for ch in "\n\r\0;&|`$<>\\'\"(){}"):
        emit(ControllerError("BAD_REQUEST", "command contains unsupported characters", 400).body())
        return 2
    try:
        _, body = dispatch(controller, original.split(), "ssh")
        emit(body)
        return 0
    except ControllerError as error:
        emit(error.body())
        return 3


def check_bind(bind: str) -> tuple[str, int]:
    host, _, port = bind.rpartition(":")
    host = host.strip("[]")
    address = ipaddress.ip_address(host)
    if address.is_unspecified:
        raise SystemExit("refusing to bind an unspecified address; use loopback or a private interface")
    if not (address.is_loopback or address.is_private or address in ipaddress.ip_network("100.64.0.0/10")):
        raise SystemExit("refusing to bind a public address")
    return host, int(port)


def load_token(path: Path | None) -> bytes:
    if path is None:
        raise SystemExit("http.tokenFile is required for serve")
    info = path.stat()
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit(f"{path} must not be readable by group/others (chmod 600)")
    token = path.read_text(encoding="utf-8").strip().encode()
    if len(token) < 32:
        raise SystemExit("token must be at least 32 characters")
    return token


def serve(controller: Controller) -> int:
    host, port = check_bind(controller.config.http_bind)
    token = load_token(controller.config.http_token_file)

    class Handler(BaseHTTPRequestHandler):
        server_version = f"dsh-audio-controller/{VERSION}"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet; audit.jsonl has the transitions
            return

        def reply(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, sort_keys=True).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self) -> bool:
            header = self.headers.get("authorization", "")
            ok = header.startswith("Bearer ") and hmac.compare_digest(header[7:].strip().encode(), token)
            if not ok:
                self.reply(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "bearer token required"}})
            return ok

        def handle_command(self, argv: list[str]) -> None:
            try:
                _, body = dispatch(controller, argv, "http")
                self.reply(200, body)
            except ControllerError as error:
                self.reply(error.status, error.body())

        def do_GET(self) -> None:  # noqa: N802
            if not self.authorized():
                return
            path, _, query = self.path.partition("?")
            params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
            routes = {"/v1/status": ["status"], "/v1/recipes": ["recipes"], "/v1/catalog": ["catalog"], "/v1/version": ["version"]}
            if path in routes:
                self.handle_command(routes[path])
            elif path == "/v1/job":
                self.handle_command(["job", params.get("id", "")])
            elif path == "/v1/health":
                self.handle_command(["health", params.get("recipe", "")])
            else:
                self.reply(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "unknown route"}})

        def do_POST(self) -> None:  # noqa: N802
            if not self.authorized():
                return
            length = int(self.headers.get("content-length", "0") or 0)
            if length > 4096:
                self.reply(413, {"ok": False, "error": {"code": "PAYLOAD_TOO_LARGE", "message": "body too large"}})
                return
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                self.reply(400, {"ok": False, "error": {"code": "BAD_REQUEST", "message": "body must be a JSON object"}})
                return
            path = self.path.partition("?")[0]
            extra = []
            for key, flag in (("requestId", "--request"), ("clientId", "--client")):
                if isinstance(body.get(key), str):
                    extra += [flag, body[key]]
            if path in {"/v1/activate", "/v1/deactivate"}:
                self.handle_command([path[4:], str(body.get("recipeId", ""))] + extra)
            elif path == "/v1/cancel":
                self.handle_command(["cancel", str(body.get("jobId", ""))])
            else:
                self.reply(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "unknown route"}})

    httpd = ThreadingHTTPServer((host, port), Handler)
    sys.stderr.write(f"dsh-audio-controller {VERSION} listening on {host}:{port}\n")
    httpd.serve_forever()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dsh-audio-ctl", description=__doc__.split("\n")[0])
    parser.add_argument("--config", default=os.environ.get("DSH_AUDIO_CONTROLLER_CONFIG", str(Path(__file__).resolve().parent.parent / "etc" / "controller.json")))
    parser.add_argument("--ssh", action="store_true", help="forced-command mode: read SSH_ORIGINAL_COMMAND")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="status | recipes | catalog | activate <id> | deactivate <id> | job <id> | cancel <id> | health <id> | serve")
    args = parser.parse_args(argv)
    controller = Controller(Config(Path(args.config)))
    if args.ssh:
        return ssh_main(controller)
    if args.command[:1] == ["serve"]:
        return serve(controller)
    if args.command[:1] == ["_worker"] and len(args.command) == 2:
        job = controller.run_worker(args.command[1])
        return 0 if job.get("phase") in {"ready", "stopped"} else 1
    try:
        _, body = dispatch(controller, args.command, "cli")
        emit(body)
        return 0
    except ControllerError as error:
        emit(error.body())
        return 3


if __name__ == "__main__":
    sys.exit(main())
