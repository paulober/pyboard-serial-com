import type { ChildProcessWithoutNullStreams } from "child_process"
import { spawn } from "child_process"
import { dirname, join } from "path"
import type {
  PyOut,
  PyOutCommandResult,
  PyOutCommandWithResponse,
  PyOutGetItemStat,
  PyOutListContents,
  PyOutPortsScan,
} from "./pyout.js"
import { PyOutType } from "./pyout.js"
import type PyFileData from "./pyfileData.js"
import type { IntermediateStats } from "./pyfileData.js"
import type { ScanOptions } from "./generateFileHashes.js"
import { scanFolder } from "./generateFileHashes.js"
import { EventEmitter } from "events"
import { EOL } from "os"
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
  calcHashes,
  getItemStat,

  // other
  reset,
}

type Command = {
  command:
    | "command"
    | "friendly_code"
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
    | "calc_file_hashes"
    | "get_item_stat"
    | "rename"
    | "exit"
    | "soft_reset"
    | "hard_reset"
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
    verbose?: boolean
  }
}

enum PyboardRunnerEvents {
  operationQueueCanceld = "operationQueueCanceld",
  nextOperation = "nextOperation",
}

function getScriptsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "scripts")
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
    device: string,
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

    console.debug(`[pyboard-serial-com] Connecting to ${this.device}`)

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

          // remove EOO from data (-4 because \n before and after EOO)
          const dataStr = data
            .toString("utf-8")
            .replaceAll("\r", "")
            .replace(EOO, "")
            .trim()

          const resp: PyOutPortsScan = {
            type: PyOutType.portsScan,
            ports: dataStr.split("\n"),
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
  private spawnNewProcess(): void {
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

  public switchDevice(device: string): void {
    if (this.device === device) {
      return
    }

    if (this.isPipeConnected()) {
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
      this.exit(code, signal)
    } else {
      this.spawnNewProcess()
      if (this.hardResetResolve) {
        this.operationOngoing = OperationType.none
        this.hardResetResolve({
          type: PyOutType.commandResult,
          result: true,
        } as PyOutCommandResult)
        this.hardResetResolve = undefined
        this.processNextOperation()
      }
    }
  }

  private onClose(): void {
    this.pipeConnected = false
  }

  private onError(err: Error): void {
    console.log(`error: ${err.message}`)
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
        }

        // start operation
        let errOccured = false
        //let cmd = JSON.stringify(command) // .replaceAll("\\\\", "\\")
        this.proc.stdin.write(JSON.stringify(command) + "\n", err => {
          errOccured = err instanceof Error
        })

        if (errOccured) {
          // operation failed
          this.operationOngoing = OperationType.none
          this.processNextOperation()
          resolve({ type: PyOutType.none } as PyOut)
        } else {
          let fsOpsProgress: number = 0

          type ProgressData = {
            written: number
            total: number
          }

          let previousProgress: ProgressData | undefined

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
              this.operationOngoing === OperationType.friendlyCommand
            ) {
              let opResult: PyOut = { type: PyOutType.none } as PyOut

              //console.debug(`stdout: ${this.outBuffer.toString('utf-8')}`)
              switch (this.operationOngoing) {
                // moved out
                //case OperationType.scanPorts:

                case OperationType.command:
                case OperationType.friendlyCommand:
                case OperationType.runFile:
                  // workaround because stdin.readline in wrapper.py is not terminatable
                  // and wrapper.py cannot write in its own stdin __SENTINEL__ requests
                  // us to do this
                  if (data.includes("!!__SENTINEL__!!")) {
                    // cause stdin.readline trigger and exit to EOO
                    this.proc.stdin.write("\n")

                    // remove sentinel from buffer as it could contain more
                    this.outBuffer = this.outBuffer.slice(
                      0,
                      -"!!__SENTINEL__!!".length
                    )
                  }

                  if (data.includes(EOO)) {
                    // stop operation - trigger resolve at end of scope
                    this.operationOngoing = OperationType.none

                    // if data contains more than EOO, then return other stuff before quitting
                    if (data.toString("utf-8").trim() !== EOO) {
                      // remove EOO from data (-4 because \n before and after EOO)
                      this.outBuffer = this.outBuffer.slice(
                        0,
                        -EOO.length - EOL.length
                      )

                      if (follow) {
                        follow(this.outBuffer.toString("utf-8"))
                      }
                    }

                    if (follow) {
                      opResult = {
                        type: PyOutType.commandResult,
                        result: true,
                      } as PyOutCommandResult
                    } else {
                      // return full buffer
                      opResult = {
                        type: PyOutType.commandWithResponse,
                        response: this.outBuffer.toString("utf-8"),
                      } as PyOutCommandWithResponse
                    }
                  } else {
                    // either keep in buffer or write into cb and clean buffer
                    if (follow) {
                      follow(this.outBuffer.toString("utf-8"))
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
                  if (data.includes(EOO)) {
                    // stop operation
                    this.operationOngoing = OperationType.none

                    opResult = {
                      type: PyOutType.fsOps,
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
                      previousProgress = undefined

                      // should be done with care as there error could have
                      // only indicated a problem with something
                      // like the directory creation before upload
                      // if the directory already existed
                      // which would cause this here to think the upload
                      // for a file failed but it actually succeeded
                      // that has been fixed but should be always kept in mind
                      fsOpsProgress++
                      break
                    } else {
                      const progData: ProgressData = JSON.parse(jsonString)

                      const { written, total } = progData

                      if (previousProgress === undefined) {
                        previousProgress = progData
                      } else if (
                        previousProgress?.written > written ||
                        previousProgress?.total !== total
                      ) {
                        fsOpsProgress++
                      }

                      const progress = Math.round((written / total) * 100)

                      follow?.(
                        `${command.args.files?.[fsOpsProgress]}: ${progress}%`
                      )

                      previousProgress = progData

                      // clean-up buffer as current progress is not needed anymore
                      break
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
                        const result = JSON.parse(
                          line.trim().replaceAll("\r", "")
                        )
                        this.remoteFileHashes.set(result.file, result.hash)
                      } else {
                        console.debug(
                          "File not found or other error," +
                            " like to big to calc hash for"
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
                        result: this.outBuffer.includes(ERR),
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
                          type: PyOutType.fsOps,
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
                          type: PyOutType.fsOps,
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
    follow: (data: string) => void
  ): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "command",
        args: {
          command: command,
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

    return this.downloadFiles(filePaths, projectRoot, follow)
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
   * Performs a hard reset on the Pico
   *
   * @param verbose Currently not supported
   * @returns PyOut of type none or
   * PyOutCommandResult (verbose=false) or PyOutCommandWithResponse (verbose=true)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async hardReset(verbose: boolean = false): Promise<PyOut> {
    if (!this.pipeConnected) {
      return { type: PyOutType.none }
    }

    return this.runCommand(
      {
        command: "hard_reset",
        args: {},
      },
      OperationType.reset
    )
  }

  /**
   * Closes the current serial connection to the Pico
   */
  public disconnect(): void {
    // TODO: maybe also remove all pending operations from the queue?
    this.proc.stdin.write(JSON.stringify({ command: "exit", args: {} }) + "\n")

    if (this.isPipeConnected()) {
      this.proc.kill()
      this.pipeConnected = false
    }
  }
}
