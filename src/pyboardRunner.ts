import type { ChildProcessWithoutNullStreams } from "child_process"
import { spawn } from "child_process"
import { dirname, join } from "path"
import type {
  PyOut,
  PyOutCommandResult,
  PyOutCommandWithResponse,
  PyOutStatus,
  PyOutGetItemStat,
  PyOutListContents,
  PyOutPortsScan,
  PyOutRtcTime,
  PyOutTabComp,
} from "./pyout.js"
import { PyOutType } from "./pyout.js"
import type PyFileData from "./pyfileData.js"
import type { IntermediateStats, RenameResult } from "./pyfileData.js"
import type { ScanOptions } from "./generateFileHashes.js"
import { scanFolder } from "./generateFileHashes.js"
import { EventEmitter } from "events"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { rp2DatetimeToDate } from "./utils.js"

const EOO: string = "!!EOO!!"
// This string is also hardcoded into pyboard.py at various places
const ERR: string = "!!ERR!!"

enum OperationType {
  none,
  scanPorts,
  command,
  friendlyCommand,
  runFile,
  listContents,

  // fsOps
  uploadFiles,
  downloadFiles,
  deleteFiles,
  createFolders,
  deleteFolders,
  deleteFolderRecursive,
  deleteFileOrFolder,
  calcHashes,
  getItemStat,
  renameItem,

  // other
  reset,
  syncRtc,
  getRtcTime,
  exit,
  checkStatus,
  retrieveTabComp,
  ctrlD,
}

type Command = {
  command:
    | "command"
    | "friendly_code"
    | "retrieve_tab_comp"
    | "run_file"
    | "double_ctrlc"
    | "list_contents"
    | "list_contents_recursive"
    | "upload_files"
    | "download_files"
    | "delete_files"
    | "mkdirs"
    | "rmdirs"
    | "rmtree"
    | "rm_file_or_dir"
    | "calc_file_hashes"
    | "get_item_stat"
    | "rename"
    | "sync_rtc"
    | "get_rtc_time"
    | "exit"
    | "status"
    | "soft_reset"
    | "hard_reset"
    | "ctrl_d"
  args: {
    command?: string
    code?: string
    // if count is 1, the local or remote path can be used as target file (and folder)
    files?: string[]
    folders?: string[]
    target?: string
    item?: string
    local?: string
    remote?: string
    // eslint-disable-next-line @typescript-eslint/naming-convention
    local_base_dir?: string
    /**
     * Should be in RP2 MicroPython datetime format
     */
    time?: string
    verbose?: boolean
    recursive?: boolean
    interactive?: boolean
  }
}

enum PyboardRunnerEvents {
  operationQueueCanceld = "operationQueueCanceld",
  nextOperation = "nextOperation",
}

function getScriptsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "scripts")
}

function cleanBuffer(buffer: Buffer): string {
  return buffer
    .toString("utf-8")
    .replace(EOO + "\r\n", "")
    .replace(EOO + "\n", "")
    .replace(EOO, "")
    .replace("!!JSONDecodeError!!" + "\r\n", "")
    .replace("!!JSONDecodeError!!" + "\n", "")
    .replace("!!JSONDecodeError!!", "")
}

export class PyboardRunner extends EventEmitter {
  public proc: ChildProcessWithoutNullStreams
  private pipeConnected: boolean = false
  private outBuffer: Buffer
  // defines the output to the parent
  private processingOperation: boolean = false
  private operationOngoing: OperationType = OperationType.none
  private runningOperation: number = -1
  private operationQueue: number[] = []
  private idCounter = 1

  private device: string
  private static readonly wrapperPyPath: string = join(
    getScriptsRoot(),
    "wrapper.py"
  )
  private pythonExe: string

  // parent
  private err: (data: Buffer | undefined) => void
  private exit: (code: number, signal: string) => void

  // cache
  private localFileHashes: Map<string, string> = new Map()
  private projectRoot: string = ""
  private remoteFileHashes: Map<string, string> = new Map()
  private hardResetResolve?: (data: PyOut) => void
  private followHardReset?: (data: string) => void

  /**
   * Auto-connects to the serial port provided.
   *
   * @param device The serial port to connect to. For example: "COM3" on Windows
   * or "/dev/ttyUSB0" on Linux
   * @param out The callback function to call when data is received from the
   * device
   * @param err The callback function to call when an error occurs (Buffer with error) or when a
   * connection to the device has been established (undefined parameter)
   * @param pythonExe The path to the python executable.
   * For example: "python" on Windows or "python3" on Linux
   */
  constructor(
    device: string = "default",
    err: (data: Buffer | undefined) => void,
    exit: (code: number, signal: string) => void,
    pythonExe: string = "default"
  ) {
    super()

    if (pythonExe === "default") {
      pythonExe = process.platform === "win32" ? "python" : "python3"
    }

    this.outBuffer = Buffer.alloc(0)

    // callback stuff
    this.err = err
    this.exit = exit

    // spawn process
    this.device = device
    this.pythonExe = pythonExe

    if (this.device !== "default") {
      console.debug(`[pyboard-serial-com] Connecting to ${this.device}`)
    }

    this.proc = spawn(
      this.pythonExe,
      [PyboardRunner.wrapperPyPath, "-d", this.device, "-b", "115200"],
      {
        stdio: "pipe",
        windowsHide: true,
        cwd: getScriptsRoot(),
      }
    )

    // Set the encoding for the subprocess stdin.
    this.proc.stdin.setDefaultEncoding("utf-8")

    this.proc.on("spawn", () => {
      if (this.device === "default") {
        // check if disconnect exists (avoid method not found error)
        if (typeof this.proc?.disconnect === "function") {
          this.proc.disconnect()
        }
        this.proc?.kill()

        return
      }

      this.pipeConnected = true
      console.debug("Spawned")

      this.err(undefined)
    })

    this.proc.stderr.on("data", (err: Buffer) => this.onStderr(err))

    this.proc.on("error", (err: Error) => this.onError(err))

    this.proc.on("exit", (code: number, signal: string) =>
      this.onExit(code, signal)
    )

    this.proc.on("close", () => this.onClose())
  }

  /**
   * Get the list of available serial ports of Picos connected to
   *
   * @param pythonExe
   * @returns
   */
  public static async getPorts(
    pythonExe: string = "default"
  ): Promise<PyOutPortsScan> {
    if (pythonExe === "default") {
      pythonExe = process.platform === "win32" ? "python" : "python3"
    }

    const proc = spawn(
      pythonExe,
      [PyboardRunner.wrapperPyPath, "--scan-ports"],
      {
        stdio: "pipe",
        windowsHide: true,
        cwd: getScriptsRoot(),
      }
    )

    return new Promise((resolve, reject) => {
      proc.stdout.on("data", (data: Buffer) => {
        // assumes that all data is printed (and recieved) at once
        if (data.includes(EOO)) {
          // kill child process
          proc.kill()

          const dataStr = data
            .toString("utf-8")
            .replaceAll("\r", "")
            .replace(EOO, "")
            .trim()

          const resp: PyOutPortsScan = {
            type: PyOutType.portsScan,
            ports: dataStr !== "" ? dataStr.split("\n") : [],
          }

          resolve(resp)
        } else {
          reject(new Error("Invalid response"))
        }
      })
    })
  }

  /**
   * Duplicate of the constructor!
   */
  private spawnNewProcess(listen = false): void {
    const launchArgs = [
      PyboardRunner.wrapperPyPath,
      "-d",
      this.device,
      "-b",
      "115200",
    ]
    if (listen && this.followHardReset) {
      // to avoid Waiting seconds prompt, until device gets available
      //launchArgs.push("--delay")
      //launchArgs.push("0.5")
      launchArgs.push("--listen")
    }

    this.proc = spawn(this.pythonExe, launchArgs, {
      stdio: "pipe",
      windowsHide: true,
      cwd: getScriptsRoot(),
    })

    // Set the encoding for the subprocess stdin.
    this.proc.stdin.setDefaultEncoding("utf-8")

    this.proc.on("spawn", () => {
      if (this.device === "default") {
        // check if disconnect exists (avoid method not found error)
        if (typeof this.proc?.disconnect === "function") {
          this.proc.disconnect()
        }
        this.proc?.kill()

        return
      }

      this.pipeConnected = true
      console.debug("Spawned")

      if (listen && this.followHardReset) {
        this.proc.stdout.on("data", (data: Buffer) => {
          if (
            data.length === 0 ||
            (data.includes("Waiting") && data.includes("seconds for pyboard"))
          ) {
            return
          }

          if (data.includes(EOO)) {
            this.proc.stdout.removeAllListeners("data")
            const dataStr = data.toString("utf-8").replace(EOO, "")
            if (this.followHardReset) {
              this.followHardReset(dataStr)
            }
            this.followHardReset = undefined
            this.resolveHardReset()
          } else if (this.followHardReset) {
            this.followHardReset(data.toString("utf-8"))
          }
        })
      }

      this.err(undefined)
    })

    this.proc.stderr.on("data", (err: Buffer) => this.onStderr(err))

    this.proc.on("error", (err: Error) => this.onError(err))

    this.proc.on("exit", (code: number, signal: string) =>
      this.onExit(code, signal)
    )

    this.proc.on("close", () => this.onClose())
  }

  public switchDevice(device: string): void {
    if (this.isPipeConnected()) {
      if (this.device === device) {
        return
      }

      this.disconnect()
    }
    if (!this.proc.killed) {
      this.proc.kill()
    }

    this.device = device

    // reset operation queue state
    if (this.operationQueue.length > 0) {
      // TODO: this will remove all promissess, maybe infinity lock
      this.removeAllListeners()

      this.operationQueue = []

      // TODO: maybe cancel all primisses by having them all listen to this event
      //this.emit(PyboardRunnerEvents.operationQueueCanceld, this.operationQueue)
    }

    // reset state
    this.operationOngoing = OperationType.none
    this.outBuffer = Buffer.alloc(0)
    this.idCounter = 1
    this.runningOperation = -1
    this.processingOperation = false

    this.spawnNewProcess()
  }

  private onStderr(data: Buffer): void {
    console.log(`stderr: ${data.toString("utf-8")}`)
    this.err(data)
  }

  private onExit(code: number, signal: string): void {
    this.pipeConnected = false
    if (this.operationOngoing !== OperationType.reset) {
      // default connection only to setup PyboardRunner class
      if (code === 0x12f9) {
        return
      }
      this.exit(code, signal)
    } else {
      // on reset exit
      this.spawnNewProcess(this.followHardReset !== undefined)
      if (this.hardResetResolve && this.followHardReset === undefined) {
        this.resolveHardReset()
      }
    }
  }

  private resolveHardReset(): void {
    this.operationOngoing = OperationType.none
    if (this.hardResetResolve !== undefined) {
      this.hardResetResolve({
        type: PyOutType.commandResult,
        result: true,
      } as PyOutCommandResult)
    }
    this.hardResetResolve = undefined
    this.processNextOperation()
  }

  private onClose(): void {
    this.pipeConnected = false
  }

  private onError(err: Error): void {
    console.log(`[pyboard-serial-com] onError: ${err.message}`)
  }

  public isPipeConnected(): boolean {
    return this.pipeConnected
  }

  /**
   * Executes a {Command} on the target device.
   *
   * @param command
   * @param operationType
   * @param follow Only respected if operationType is command or friendlyCommand.
   * Will be called with progress
   * @returns
   */
  private async runCommand(
    command: Command,
    operationType: OperationType,
    follow?: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none } as PyOut
    }

    return new Promise(resolve => {
      const opId = this.idCounter++

      this.once(`${PyboardRunnerEvents.nextOperation}_${opId}`, async () => {
        // operation already in progress?
        if (this.operationOngoing !== OperationType.none) {
          resolve({ type: PyOutType.none } as PyOut)

          return
        }

        // set operation type so that the stdout handler knows what to do
        this.operationOngoing = operationType

        if (command.command === "hard_reset") {
          // save for delayed resolve
          this.hardResetResolve = resolve
          this.followHardReset = follow
        }

        // start operation
        let errOccured = false
        //let cmd = JSON.stringify(command) // .replaceAll("\\\\", "\\")
        this.proc.stdin.write(JSON.stringify(command) + "\n", err => {
          errOccured = err instanceof Error
        })
        if (this.operationOngoing === OperationType.exit) {
          this.operationOngoing = OperationType.none
          resolve({ type: PyOutType.none } as PyOut)
        } else if (follow) {
          // give the callbacks a hint that the operation is now starting
          follow("")
        }

        if (errOccured) {
          // operation failed
          this.operationOngoing = OperationType.none
          this.processNextOperation()
          resolve({ type: PyOutType.none } as PyOut)
        } else {
          type ProgressData = {
            written: number
            total: number
            currentFilePos: number
            totalFilesCount: number
          }

          // listen for operation output
          this.proc.stdout.addListener("data", (data: Buffer) => {
            this.outBuffer = Buffer.concat(
              [this.outBuffer, data],
              this.outBuffer.length + data.length
            )
            // DEBUG: for single step debugging to see outBuffer content
            // in a readable format
            //const f = this.outBuffer.toString("utf-8")

            if (
              data.includes("\n") ||
              this.operationOngoing === OperationType.friendlyCommand ||
              (this.operationOngoing === OperationType.command &&
                command.args.interactive) ||
              this.operationOngoing === OperationType.runFile
            ) {
              let opResult: PyOut = { type: PyOutType.none } as PyOut

              //console.debug(`stdout: ${this.outBuffer.toString("utf-8")}`)
              switch (this.operationOngoing) {
                // moved out
                //case OperationType.scanPorts:

                case OperationType.command:
                case OperationType.friendlyCommand:
                case OperationType.retrieveTabComp:
                case OperationType.runFile:
                case OperationType.ctrlD:
                  // workaround because stdin.readline in wrapper.py is not terminatable
                  // and wrapper.py cannot write in its own stdin __SENTINEL__ requests
                  // us to do this
                  if (
                    data.includes("!!__SENTINEL__!!") ||
                    this.outBuffer.includes(
                      "!!__SENTINEL__!!",
                      undefined,
                      "utf-8"
                    )
                  ) {
                    // cause stdin.readline trigger and exit to EOO
                    this.proc.stdin.write("\n")

                    // remove sentinel from buffer as it could contain more
                    this.outBuffer = Buffer.from(
                      this.outBuffer
                        .toString("utf-8")
                        .replace("!!__SENTINEL__!!", ""),
                      "utf-8"
                    )
                  } else if (data.includes(ERR)) {
                    this.disconnect(true)

                    if (follow) {
                      follow(ERR)
                      opResult = {
                        type: PyOutType.commandResult,
                        result: true,
                      } as PyOutCommandResult
                    } else {
                      // return full buffer
                      opResult = {
                        type: PyOutType.commandWithResponse,
                        response: cleanBuffer(this.outBuffer),
                      } as PyOutCommandWithResponse
                    }

                    break
                  }

                  if (data.includes(EOO)) {
                    const isTabComp =
                      this.operationOngoing === OperationType.retrieveTabComp
                    // stop operation - trigger resolve at end of scope
                    this.operationOngoing = OperationType.none

                    // if data contains more than EOO, then return other stuff before quitting
                    if (data.toString("utf-8").trim() !== EOO) {
                      // remove EOO from data (-4 because \n before and after EOO)
                      const response = cleanBuffer(this.outBuffer)

                      if (follow) {
                        follow(response)
                      }
                    }

                    if (follow) {
                      opResult = {
                        type: PyOutType.commandResult,
                        result: true,
                      } as PyOutCommandResult
                    } else {
                      if (isTabComp) {
                        const cleanBuf = cleanBuffer(this.outBuffer)
                        const isSimple = cleanBuf.includes(
                          "!!SIMPLE_AUTO_COMP!!" // len =20
                        )
                        opResult = {
                          type: PyOutType.tabComp,
                          isSimple: isSimple,
                          completion: isSimple
                            ? cleanBuf.slice(20).replace("\n", "")
                            : cleanBuf,
                        } as PyOutTabComp
                      } else {
                        // return full buffer
                        opResult = {
                          type: PyOutType.commandWithResponse,
                          response: cleanBuffer(this.outBuffer),
                        } as PyOutCommandWithResponse
                      }
                    }
                  } else {
                    // either keep in buffer or write into cb and clean buffer
                    if (follow) {
                      const response = cleanBuffer(this.outBuffer)

                      follow(response)
                    }
                    // if not follow result has to be kept in buffer so return to avoid clean-up
                    else {
                      return
                    }
                  }

                  break

                case OperationType.listContents:
                  // TODO: unexpected behavior if data contains ERR and no content!
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    // for each line in outBuffer
                    const files: PyFileData[] = []
                    for (const line of this.outBuffer
                      // -4 for trailing and leading\n
                      // (not needed because of parts.length check)
                      .slice(0, -EOO.length)
                      .toString("utf-8")
                      .replaceAll("\r", "")
                      .split("\n")) {
                      const parts: string[] = line.trimStart().split(" ")

                      // TODO: maybe merge parts with index 2 and up
                      // to support file names with spaces
                      if (parts.length !== 2) {
                        continue
                      }

                      const file: PyFileData = {
                        path: parts[1],
                        isDir: parts[1].endsWith("/"),
                        size: parseInt(parts[0]),
                      }
                      files.push(file)
                    }

                    opResult = {
                      type: PyOutType.listContents,
                      response: files,
                    } as PyOut

                    // jump to clear buffer as operation is now finishd
                    break
                  }

                  // avoid clearing of buffer as operation is not finished
                  // TODO: maybe check for timeout
                  // return if listContents but not EOO because operation is not done
                  return

                case OperationType.uploadFiles:
                case OperationType.downloadFiles:
                case OperationType.deleteFiles:
                case OperationType.createFolders:
                case OperationType.deleteFolders:
                case OperationType.deleteFolderRecursive:
                case OperationType.deleteFileOrFolder:
                case OperationType.syncRtc:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    opResult = {
                      type: PyOutType.status,
                      // return false if operation experienced an error
                      status: this.outBuffer.includes(ERR)
                        ? this.outBuffer.includes("EXIST")
                        : true,
                    } as PyOut

                    // jump to buffer clean-up and resolve as operation is now finished
                    break
                  } else if (command.args.verbose && follow) {
                    // if verbose mode is on, then interpret output as progress
                    const jsonString: string = this.outBuffer.toString("utf-8")

                    // calculate progress

                    if (
                      jsonString.includes(ERR) ||
                      jsonString.includes("!!Exception!!")
                    ) {
                      // avoid > and < checks for next file progress
                      //previousProgress = undefined

                      // should be done with care as there error could have
                      // only indicated a problem with something
                      // like the directory creation before upload
                      // if the directory already existed
                      // which would cause this here to think the upload
                      // for a file failed but it actually succeeded
                      // that has been fixed but should be always kept in mind
                      //fsOpsProgress++
                      break
                    } else {
                      try {
                        const progData: ProgressData = JSON.parse(jsonString)

                        const {
                          written,
                          total,
                          currentFilePos,
                          totalFilesCount,
                        } = progData

                        //const progress = Math.round((written / total) * 100)

                        // TODO: currentFilePos is not good for index as
                        // the list is sorted in wrapper.py -> different order
                        follow?.(
                          `'${command.args.files?.[currentFilePos - 1]}' ` +
                            `[${currentFilePos}/${totalFilesCount}]`
                        )

                        // clean-up buffer as current progress is not needed anymore
                        break
                      } catch (e) {
                        console.error(
                          "[pyboard-serial-com]: Error parsing JSON: JSON:(",
                          jsonString,
                          ") Error:",
                          e
                        )
                        break
                      }
                    }
                  }

                  // avoid clean-up of buffer
                  return

                case OperationType.calcHashes:
                  if (data.includes(EOO)) {
                    // stop operation
                    //this.operationOngoing = OperationType.none

                    this.remoteFileHashes.clear()
                    // for each line in outBuffer
                    for (const line of this.outBuffer
                      // -2 for trailing \r or \n
                      // (not needed because of hashes.length check)
                      .slice(0, -EOO.length - 2)
                      .toString("utf-8")
                      .split("\n")) {
                      if (line.length < 4) {
                        continue
                      }

                      if (!line.includes("error") && !line.includes(ERR)) {
                        try {
                          const result = JSON.parse(
                            line.trim().replaceAll("\r", "")
                          )
                          this.remoteFileHashes.set(result.file, result.hash)
                        } catch (e) {
                          console.debug(
                            "[pyboard-serial-com]: Error parsing JSON: ",
                            e
                          )
                        }
                      } else {
                        console.debug(
                          "[pyboard-serial-com] File not found (or other " +
                            "error, like to big to calc hash for)"
                        )
                      }
                    }

                    break
                  }

                  return

                case OperationType.getItemStat:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    if (this.outBuffer.includes(ERR)) {
                      opResult = {
                        type: PyOutType.getItemStat,
                        stat: null,
                      } as PyOutGetItemStat
                    } else {
                      try {
                        const jsonString: string = this.outBuffer
                          .toString("utf-8")
                          .replaceAll("\r", "")
                          .replaceAll("\n", "")
                          .slice(0, -EOO.length)

                        const itemStat: IntermediateStats =
                          JSON.parse(jsonString)

                        opResult = {
                          type: PyOutType.getItemStat,
                          stat: {
                            path: command.args.item ?? "",
                            isDir: itemStat.is_dir,
                            size: itemStat.size,
                            // multiply by 1000 to get milliseconds as
                            // timestamp is coming from python
                            lastModified: new Date(
                              itemStat.modification_time * 1000
                            ),
                            created: new Date(itemStat.creation_time * 1000),
                          } as PyFileData,
                        } as PyOutGetItemStat
                      } catch (e) {
                        console.error(e)
                        opResult = {
                          type: PyOutType.getItemStat,
                          stat: null,
                        } as PyOutGetItemStat
                      }
                    }

                    break
                  }

                  return

                case OperationType.renameItem:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    if (this.outBuffer.includes(ERR)) {
                      opResult = {
                        type: PyOutType.status,
                        status: false,
                      } as PyOutStatus
                    } else {
                      try {
                        const jsonString: string = this.outBuffer
                          .toString("utf-8")
                          .replaceAll("\r", "")
                          .replaceAll("\n", "")
                          .slice(0, -EOO.length)

                        const result: RenameResult = JSON.parse(jsonString)

                        if (!result.success && result.error !== undefined) {
                          console.warn(
                            "[pyboard-serial-com] rename operation " +
                              "failed with message: %s",
                            result.error
                          )
                        }

                        opResult = {
                          type: PyOutType.status,
                          status: result.success,
                        } as PyOutStatus
                      } catch (e) {
                        console.error(e)
                        opResult = {
                          type: PyOutType.status,
                          status: false,
                        } as PyOutStatus
                      }
                    }

                    break
                  }

                  return

                case OperationType.getRtcTime:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    if (this.outBuffer.includes(ERR)) {
                      opResult = {
                        type: PyOutType.getRtcTime,
                        time: null,
                      } as PyOutRtcTime
                    } else {
                      const time: string = this.outBuffer
                        .toString("utf-8")
                        .replaceAll("\r", "")
                        .replaceAll("\n", "")
                        .slice(0, -EOO.length)

                      opResult = {
                        type: PyOutType.getRtcTime,
                        time: rp2DatetimeToDate(time),
                      } as PyOutRtcTime
                    }

                    break
                  }

                  return

                case OperationType.checkStatus:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    opResult = {
                      type: PyOutType.status,
                      status:
                        !this.outBuffer.includes(ERR) &&
                        !this.outBuffer.includes("Exception"),
                    } as PyOutStatus

                    break
                  } else if (data.includes("Exception")) {
                    // stop operation
                    this.operationOngoing = OperationType.none
                    this.onExit(3, "")

                    opResult = {
                      type: PyOutType.status,
                      status: false,
                    } as PyOutStatus

                    break
                  }

                  return

                case OperationType.reset:
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    if (command.args.verbose) {
                      opResult = {
                        type: PyOutType.commandWithResponse,
                        response: this.outBuffer
                          .toString("utf-8")
                          .trimEnd()
                          .slice(0, -EOO.length),
                      } as PyOutCommandWithResponse
                    } else {
                      opResult = {
                        type: PyOutType.commandResult,
                        result: !this.outBuffer.includes(ERR),
                      } as PyOutCommandResult
                    }

                    // jump to buffer clean-up and resolve as operation is now finished
                    break
                  }

                  // avoid clearing of buffer as operation is not finished
                  return

                default:
                  console.log(`stdout: ${this.outBuffer.toString("utf-8")}`)
                  break
              }

              // flush outBuffer
              this.outBuffer = Buffer.alloc(0)

              // operation finished
              if (
                this.operationOngoing === OperationType.none ||
                this.operationOngoing === OperationType.calcHashes
              ) {
                this.proc.stdout.removeAllListeners()
                const opIsCalcHashes =
                  this.operationOngoing === OperationType.calcHashes
                this.operationOngoing = OperationType.none
                this.processNextOperation()

                // to avoid calling resolve after calc hashes as it's not
                if (!opIsCalcHashes) {
                  resolve(opResult)
                } else {
                  // add operation to queue and wait
                  if (follow) {
                    this.uploadProject(follow)
                      .then((data: PyOut) => {
                        resolve(data)
                      })
                      .catch(() => {
                        resolve({
                          type: PyOutType.status,
                          status: false,
                        } as PyOut)
                      })
                  } else {
                    this.uploadProject()
                      .then((data: PyOut) => {
                        resolve(data)
                      })
                      .catch(() => {
                        resolve({
                          type: PyOutType.status,
                          status: false,
                        } as PyOut)
                      })
                  }
                }
              }
            }
          })
        }
      })

      this.addOperation(opId)
    })
  }

  public async writeToPyboard(data: string): Promise<void> {
    if (
      !this.proc.stdin &&
      this.operationOngoing !== OperationType.friendlyCommand
    ) {
      return
    }
    this.proc.stdin.write(data)
  }

  private async addOperation(id: number): Promise<void> {
    this.operationQueue.push(id)

    if (!this.processingOperation) {
      this.processNextOperation()
    }
  }

  private async processNextOperation(): Promise<void> {
    if (this.operationQueue.length === 0) {
      // Queue is empty
      this.processingOperation = false

      return
    }

    // Acquire lock
    this.processingOperation = true

    const op: number | undefined = this.operationQueue.shift()
    if (op) {
      this.runningOperation = op
      this.emit(`${PyboardRunnerEvents.nextOperation}_${op}`)
    }
  }

  /**
   * Executes a command on the remote host
   *
   * @param command The command to be executed on the remote host
   * @returns If the operation was successfully started
   */
  public async executeCommand(
    command: string,
    follow?: (data: string) => void,
    interactive?: boolean
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "command",
        args: {
          command: command,
          interactive: interactive,
        },
      },
      OperationType.command,
      follow
    )
  }

  /**
   * Executes a command on the remote host and follows the output
   * Caller can interact thought this.s
   *
   * @param command
   * @param follow
   * @returns
   */
  public async executeFriendlyCommand(
    command: string,
    follow: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    // does not need verbose to be set as follow will
    // be respected by stdout listener
    return this.runCommand(
      {
        command: "friendly_code",
        args: {
          code: command,
        },
      },
      OperationType.friendlyCommand,
      follow
    )
  }

  /**
   * Retrieve tab-completion result from remote REPL.
   *
   * @param line The line to get tab completion for
   * @returns PyOutWithCommandResponse object
   */
  public async retrieveTabCompletion(line: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "retrieve_tab_comp",
        args: {
          code: line,
        },
      },
      OperationType.retrieveTabComp
    )
  }

  // TODO: maybe return PyOut... instead of PyOut to reduce checks and casts
  /**
   * Lists the contents of a directory on the remote host (non-recursive)
   *
   * @param remotePath The path on remote to directory to be scaned
   * @returns PyOutListContents object
   */
  public async listContents(remotePath: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "list_contents",
        args: {
          target: remotePath,
        },
      },
      OperationType.listContents
    )
  }

  /**
   * Lists the contents of a directory on the remote host (non-recursive)
   *
   * @param remotePath The path on remote to directory to be scaned
   * @returns PyOutListContents object
   */
  public async listContentsRecursive(remotePath: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "list_contents_recursive",
        args: {
          target: remotePath,
        },
      },
      OperationType.listContents
    )
  }

  /**
   * Uploads files to the remote host
   *
   * @param files The files to upload. If count is 1, the local or remote path
   * CAN be used as target file or folder
   * @param target The target folder. If files count is 1, this can be used as target
   * else it will be used as target folder where ALL files will be uploaded to
   * @param localBaseDir If set the local path will be stripped from the file and the
   * remaining path will be appended to the target path for each file
   * @returns If the operation was successfully started
   */
  public async uploadFiles(
    files: string[],
    target: string,
    localBaseDir?: string,
    follow?: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    const command: Command = {
      command: "upload_files",
      args: {
        files: files,
        remote: target,
        verbose: !!follow,
      },
    }

    if (localBaseDir) {
      command.args.local_base_dir = localBaseDir
    }

    return this.runCommand(command, OperationType.uploadFiles, follow)
  }

  /**
   * Downloads files from the remote host
   *
   * @param files The files to download. If count is 1, the local or remote path
   * CAN be used as target file or folder
   * @param target The target folder. If files count is 1, this can be used as local target file
   * @returns If the operation was successfully started
   */
  public async downloadFiles(
    files: string[],
    target: string,
    follow?: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "download_files",
        args: {
          files: files,
          local: target,
          verbose: !!follow,
        },
      },
      OperationType.downloadFiles,
      follow
    )
  }

  /**
   * Deletes files on the remote host
   * (Pyboard tool does only process one delete file request at a time
   * so this is not a batch operation but it is still faster than calling
   * deleteFile multiple times)
   *
   * @param files The files on the remote to delete. Does not require ':' prefix
   */
  public async deleteFiles(files: string[]): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "delete_files",
        args: {
          files: files,
        },
      },
      OperationType.deleteFiles
    )
  }

  /**
   * Creates folders on the remote host
   *
   * @param folders The folders to create on the remote host
   * @returns If the operation was successfully started
   */
  public async createFolders(folders: string[]): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "mkdirs",
        args: {
          folders: folders,
        },
      },
      OperationType.createFolders
    )
  }

  /**
   * Deletes folders on the remote host
   *
   * @param folders The folders on the remote to delete. Does not require ':' prefix
   * @returns If the operation was successfully started
   */
  public async deleteFolders(folders: string[]): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "rmdirs",
        args: {
          folders: folders,
        },
      },
      OperationType.deleteFolders
    )
  }

  /**
   * Deletes a folder and all its contents on the remote host
   *
   * @param folder The folder on the remote to delete. Does not require ':' prefix
   * @returns If the operation was successfully started
   */
  public async deleteFolderRecursive(folder: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "rmtree",
        args: {
          folders: [folder],
        },
      },
      OperationType.deleteFolderRecursive
    )
  }

  /**
   * Deletes a file or folder on the Pico (recursive)
   *
   * @param path The path to the file or folder to delete (without ':')
   * @param recursive If the delete should be recursive
   * @returns
   */
  public async deleteFileOrFolder(
    path: string,
    recursive: boolean
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "rm_file_or_dir",
        args: {
          target: path,
          recursive: recursive,
        },
      },
      OperationType.deleteFileOrFolder
    )
  }

  /**
   * Starts the upload process of a project folder
   * After this operation it will not trigger the 'out' callback
   * instead it will transition to the 'uploading' state and then emit and fsOps
   * complete callback
   *
   * TODO: the resulting fsOps complete could be confused with an operation added to queue
   * after this one and before upload operations has been triggered by the projectUpload
   *
   * @param projectFolder Root folder of the project to upload
   * @param fileTypes File types to upload. Empty array for all
   * @param ignoredItems Items to ignore
   */
  public async startUploadingProject(
    projectFolder: string,
    fileTypes: string[],
    ignoredItems: string[],
    follow?: (data: string) => void
  ): Promise<PyOut> {
    /*const localHashes = await generateFileHashes(
      projectFolder,
      fileTypes,
      ignoredItems
    )*/
    const localHashes = scanFolder({
      folderPath: projectFolder,
      fileTypes,
      ignoredItems,
    } as ScanOptions)

    // add localHashes to this.localFileHashes
    this.localFileHashes = localHashes
    this.projectRoot = projectFolder

    // only parse follow not set verbose as calc_file_hashes
    // operation does not support verbose but
    // OperationType.calcHashes followed upload operation supports it
    return this.runCommand(
      {
        command: "calc_file_hashes",
        args: {
          files: Array.from(localHashes.keys(), file =>
            // clear out any Windows style and duble slashes
            file.replace("\\", "/").replace("//", "/")
          ),
        },
      },
      OperationType.calcHashes,
      follow
    )
  }

  /**
   * Upload a files not present or outdated on the remote host
   *
   * PyboardRunner.remoteFileHashes and PyboardRunner.localFileHashes must be set!
   *
   * @param follow If set, the follow callback will be called with the output of the operation
   * @returns
   */
  private async uploadProject(follow?: (data: string) => void): Promise<PyOut> {
    const filesToUpload = [...this.localFileHashes.keys()]
      .filter(
        file =>
          !this.remoteFileHashes.has(file) ||
          this.remoteFileHashes.get(file) !== this.localFileHashes.get(file)
      )
      .map(file => join(this.projectRoot, file), this)

    if (filesToUpload.length > 0) {
      return this.uploadFiles(filesToUpload, ":", this.projectRoot, follow)
    }

    return { type: PyOutType.none }
  }

  /**
   * Downloads all files from the remote host to the project root
   */
  public async downloadProject(
    projectRoot: string,
    follow?: (data: string) => void
  ): Promise<PyOut> {
    //this.downloadFiles(":", this.projectRoot)
    //this.downloadProjectRecursive(projectRoot, ":")
    const contents = await this.listContentsRecursive("/")

    if (contents.type !== PyOutType.listContents) {
      return { type: PyOutType.none }
    }

    const filePaths = (contents as PyOutListContents).response.map(f => f.path)

    // redundant as downloadFiles in wrapper also does this
    //await createFolderStructure(filePaths, projectRoot)

    return this.downloadFiles(
      filePaths,
      // if only one file is downloaded pyboard treats the target directory as target file
      filePaths.length > 1 ? projectRoot : projectRoot + filePaths[0],
      follow
    )
  }

  /**
   * Executes a local file on the remote host
   *
   * @param file The file to execute (absolue path)
   * @returns PyOut
   */
  public async runFile(
    file: string,
    follow: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected || !existsSync(file)) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "run_file",
        args: {
          files: [file],
        },
      },
      OperationType.runFile,
      follow
    )
  }

  /**
   * Get fs details of a file or folder on the Pico
   *
   * @param itemPath The path of the item on the Pico
   * @returns
   */
  public async getItemStat(itemPath: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "get_item_stat",
        args: {
          item: itemPath,
        },
      },
      OperationType.getItemStat
    )
  }

  /**
   * Renames a file or folder on the Pico (W)
   *
   * @param oldPath The current path of the item to rename
   * @param newPath Should be in same dir as oldPath
   * @returns {PyOutStatus} PyOutStatus or PyOutType.none if pipe is not connected
   */
  public async renameItem(oldPath: string, newPath: string): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "rename",
        args: {
          item: oldPath,
          target: newPath,
        },
      },
      OperationType.renameItem
    )
  }

  /**
   * Sync the RTC on the Pico (W) with the local system time
   *
   * @returns {PyOutStatus} PyOutStatus with status false if pipe is not connected not `type: none`!
   */
  public async syncRtc(): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.status, status: false } as PyOutStatus
    }

    return this.runCommand(
      {
        command: "sync_rtc",
        // "args.time" is set later in the wrapper
        // to get it as accurate as possible
        args: {},
      },
      OperationType.syncRtc
    )
  }

  /**
   * Get the RTC time on the Pico (W) as a Date object
   *
   * @returns {PyOutRtcTime} PyOutRtcTime
   */
  public async getRtc(): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "get_rtc_time",
        args: {},
      },
      OperationType.getRtcTime
    )
  }

  /**
   * Performs a soft reset on the Pico
   *
   * @param verbose Currently not supported
   * @returns PyOut of type none or
   * PyOutCommandResult (verbose=false) or PyOutCommandWithResponse (verbose=true)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async softReset(verbose: boolean = false): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "soft_reset",
        args: {},
      },
      OperationType.reset
    )
  }

  /**
   * Ping the wrapper to check if it is still connected to the Pico
   *
   * @returns
   */
  public async checkStatus(): Promise<void> {
    if (!this.pipeConnected || this.operationQueue.length > 0) {
      return
    }

    await this.runCommand(
      {
        command: "status",
        args: {},
      },
      OperationType.checkStatus
    )
  }

  /**
   * Performs a hard reset on the Pico
   *
   * @param follow Listen to boot output (experimental, don't use if script isn't
   * running for a time and if it doesn't sends output to the repl)
   * @returns PyOut of type none or PyOutCommandResult
   */
  public async hardReset(follow?: (data: string) => void): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "hard_reset",
        args: {},
      },
      OperationType.reset,
      follow
    )
  }

  /**
   * Sends a ctrl+d to the Pico and follows the output.
   * (it's like soft reset but it also reruns main and boot)
   *
   * @param follow Listen the main.py and boot.py output
   * @returns PyOut of type none or PyOutCommandResult
   */
  public async sendCtrlD(follow: (data: string) => void): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "ctrl_d",
        args: {},
      },
      OperationType.ctrlD,
      follow
    )
  }

  /**
   * Closes the current serial connection to the Pico
   */
  public async disconnect(afterDisconnect: boolean = false): Promise<void> {
    if (afterDisconnect) {
      this.proc.kill()
      this.pipeConnected = false

      // resolve queue
      this.operationOngoing = OperationType.exit

      // each operation will imidiately resolve as operationOngoing is not set to none
      this.operationQueue.forEach(op => {
        this.emit(`${PyboardRunnerEvents.nextOperation}_${op}`)
      })

      this.operationOngoing = OperationType.none

      return
    }

    // TODO: maybe also remove all pending operations from the queue?
    await this.runCommand({ command: "exit", args: {} }, OperationType.exit)

    // wait for the sub-process to exit
    await new Promise(resolve => setTimeout(resolve, 500))

    if (this.isPipeConnected()) {
      this.proc.kill()
      this.pipeConnected = false
    }
  }
}
