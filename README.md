# pyboard-serial-com

A straightforward library for establishing communication with Raspberry Pi Pico (W) boards using the `pyboard.py` utility (from the MicroPython project) via the serial port.

> This projects main/initial purpose is to offload the communication core and utilities from the [MicroPico repo](https://github.com/paulober/MicroPico) into a seperate repository for development and usability reasons. Also it is/was meant to replace the old ugly asynchronous mess of a communication piece to allow the developement of new more complex features based on the official `pyboard.py` module developed on the MicroPython repo.

## Installation

Before installing, make sure to authenticate with GitHub Package Registry or using a `.npmrc` file. See "[Configuring npm for use with GitHub Package Registry](https://help.github.com/en/articles/configuring-npm-for-use-with-github-package-registry#authenticating-to-github-package-registry)."

`$ npm install @paulober/pyboard-serial-com`

Or add this package to your `package.json` file:

```json
"dependencies": {
    "@paulober/pyboard-serial-com": "2.0.1"
}
```

NOTE: requires the scripts directory to be present in your work-/output directory

## Supported platforms

| Platform               | Architectures |
| ---------------------- | ------------- |
| Windows                | x64           |
| Linux                  | x64, arm64    |
| macOS (10.9 or higher) | x64, arm64    |

## Usage

```typescript
import { PyboardRunner } from "@paulober/pyboard-serial-com"

const pyboardRunner = new PyboardRunner(
    "COM3",
    (data: Buffer | undefined) => {
        if (data !== undefined) {
            console.error(`stderr: ${data?.toString()}`)
        } else {
            // connected sucessfully
            console.debug("Connected!")
        }
    },
    (code: number, signal: string) => {
        if (code) {
            console.error(`child process exited with code ${code}`)
        }
        if (signal) {
            console.error(`child process killed with signal ${signal}`)
        }
        console.debug("Done - exit")
    }
)

pyboardRunner.disconnect()
```

## Planed changes
- Maybe switch to RXJS compared to the current custom solution for queueing

## Known issues
...
