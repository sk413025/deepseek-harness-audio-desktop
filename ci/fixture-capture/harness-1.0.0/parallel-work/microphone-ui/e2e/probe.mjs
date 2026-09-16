// Ad-hoc probe: node probe.mjs <cdpPort> <js-expression>
import { attach } from './cdp-lib.mjs'
const [port, expression] = process.argv.slice(2)
const page = await attach(Number(port))
console.log(JSON.stringify(await page.evaluate(expression), null, 2))
page.close()
