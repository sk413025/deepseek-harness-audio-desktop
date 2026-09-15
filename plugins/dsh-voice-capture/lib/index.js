//#region src/index.ts
/**
* Host half of dsh-voice-capture. The package contributes only browser UI;
* this Loader row exists so the client-module scan finds its `dsh.client`
* declaration. It registers nothing and reads no configuration.
*/
/** Plugin name reported by the Loader. */
const name = "dsh-voice-capture";
/** No host contributions. */
function apply() {}
//#endregion
export { apply, name };
