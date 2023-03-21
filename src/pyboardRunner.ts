import type { ChildProcessWithoutNullStreams } from "child_process"
import { spawn } from "child_process"
import path = require("path")
import { PyOutType } from "./pyout"
import type { PyOut, PyOutCommand, PyOutPortsScan } from "./pyout"
import type PyFileData from "./pyfileData"

const EOO: string = "!!EOO!!"
// This string is also hardcoded into pyboard.py at various places
const ERR: string = "!!ERR!!"

export const SCAN_DEVICE = "!!SCAN!!"

enum OperationType {
  none,
  scanPorts,
  command,
  listContents,

  // fsOps
  uploadFiles,
  downloadFiles,
  deleteFiles,
  createFolders,
  deleteFolders,
  deleteFolderRecursive,
}

type Command = {
  command:
    | "command"
    | "list_contents"
    | "upload_files"
    | "download_files"
    | "delete_files"
    | "mkdirs"
    | "rmdirs"
    | "rmtree"
    | "exit"
  args: {
    command?: string
    // if count is 1, the local or remote path can be used as target file (and folder)
    files?: string[]
    folders?: string[]
    target?: string
    local?: string
    remote?: string
  }
}

type PyOperation = {
  callback: (
    runCommand: (command: Command, operationType: OperationType) => boolean
  ) => void
}

export class PyboardRunner {
  public proc: ChildProcessWithoutNullStreams
  private pipeConnected: boolean = false
  private outBuffer: Buffer
  // defines the output to the parent
  private processingOperation: boolean = false
  private operationOngoing: OperationType = OperationType.none
  private operationQueue: PyOperation[] = []

  private device: string
  private readonly wrapperPyPath: string = path.join(
    __dirname,
    "..",
    "scripts",
    "wrapper.py"
  )
  private pythonExe: string

  // parent
  private out: (data: PyOut) => Promise<void>
  private err: (data: Buffer | undefined) => void
  private exit: (code: number, signal: string) => void

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
    out: (data: PyOut) => Promise<void>,
    err: (data: Buffer | undefined) => void,
    exit: (code: number, signal: string) => void,
    pythonExe: string = "default"
  ) {
    if (pythonExe === "default") {
      pythonExe = process.platform === "win32" ? "python" : "python3"
    }

    this.outBuffer = Buffer.alloc(0)

    // callback stuff
    this.out = out
    this.err = err
    this.exit = exit

    // spawn process
    this.device = device
    this.pythonExe = pythonExe

    if (this.device === SCAN_DEVICE) {
      console.debug("Scanning ports")
      this.operationOngoing = OperationType.scanPorts
    } else {
      console.debug(`Connecting to ${this.device}`)
    }

    this.proc = spawn(
      this.pythonExe,
      this.device === SCAN_DEVICE
        ? [this.wrapperPyPath, "--scan-ports"]
        : [this.wrapperPyPath, "-d", this.device, "-b", "115200"],
      {
        stdio: "pipe",
        windowsHide: true,
        cwd: path.join(__dirname, "..", "scripts"),
      }
    )

    this.proc.on("spawn", () => {
      this.pipeConnected = true
      console.debug("Spawned")

      this.err(undefined)
    })

    this.proc.stdout.on("data", (data: Buffer) => this.onStdout(data))

    this.proc.stderr.on("data", (err: Buffer) => this.onStderr(err))

    this.proc.on("error", (err: Error) => this.onError(err))

    this.proc.on("exit", (code: number, signal: string) =>
      this.onExit(code, signal)
    )

    this.proc.on("close", () => this.onClose())
  }

  /**
   * Duplicate of the constructor!
   */
  private spawnNewProcess(): void {
    this.proc = spawn(
      this.pythonExe,
      this.device === SCAN_DEVICE
        ? [this.wrapperPyPath, "--scan-ports"]
        : [this.wrapperPyPath, "-d", this.device, "-b", "115200"],
      {
        stdio: "pipe",
        windowsHide: true,
        cwd: path.join(__dirname, "..", "scripts"),
      }
    )

    this.proc.on("spawn", () => {
      this.pipeConnected = true
      console.debug("Spawned")

      this.err(undefined)
    })

    this.proc.stdout.on("data", (data: Buffer) => this.onStdout(data))

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
      this.operationQueue = []
      this.operationOngoing = OperationType.none
      this.processingOperation = false
    }

    this.spawnNewProcess()
  }

  private onStdout(data: Buffer): void {
    this.outBuffer = Buffer.concat(
      [this.outBuffer, data],
      this.outBuffer.length + data.length
    )
    // DEBUG: for single step debugging to see outBuffer content
    // in a readable format
    //const f = this.outBuffer.toString('utf-8')

    if (data.includes("\n")) {
      //console.debug(`stdout: ${this.outBuffer.toString('utf-8')}`)
      switch (this.operationOngoing) {
        case OperationType.scanPorts:
          if (data.includes(EOO)) {
            // stop operation
            this.operationOngoing = OperationType.none

            // if data contains more than EOO, then return other stuff before quitting
            if (this.outBuffer.toString("utf-8").trim() !== EOO) {
              // remove EOO from data (-4 because \n before and after EOO)
              this.outBuffer = this.outBuffer.slice(0, -EOO.length - 4)
            }

            const resp: PyOutPortsScan = {
              type: PyOutType.portsScan,
              ports: this.outBuffer.toString("utf-8").split("\n"),
            }
            this.out(resp)

            break
          }

          return

        case OperationType.command:
          if (data.includes(EOO)) {
            // stop operation
            this.operationOngoing = OperationType.none

            // if data contains more than EOO, then return other stuff before quitting
            if (data.toString("utf-8").trim() !== EOO) {
              // remove EOO from data (-4 because \n before and after EOO)
              this.outBuffer = this.outBuffer.slice(0, -EOO.length - 4)
              const resp: PyOutCommand = {
                type: PyOutType.command,
                response: this.outBuffer.toString("utf-8"),
              }
              this.out(resp)
            }
          }

          const resp: PyOutCommand = {
            type: PyOutType.command,
            response: this.outBuffer.toString("utf-8"),
          }
          this.out(resp)

          break

        case OperationType.listContents:
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
              .split("\n")) {
              const parts: string[] = line
                .trimStart()
                .replaceAll("\r", "")
                .split(" ")

              // TODO: maybe merge parts with index 2 and up
              // to support file names with spaces
              if (parts.length !== 2) {
                continue
              }

              const file: PyFileData = {
                path: parts[1],
                size: parseInt(parts[0]),
              }
              files.push(file)
            }
            this.out({
              type: PyOutType.listContents,
              response: files,
            } as PyOut)

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

            this.out({
              type: PyOutType.fsOps,
              // return false if operation experienced an error
              status: !this.outBuffer.includes(ERR),
            } as PyOut)

            // jump to buffer deletion as operation is now finished
            break
          }

          // avoid deletion of buffer
          return

        default:
          console.log(`stdout: ${this.outBuffer.toString("utf-8")}`)
          break
      }

      // flush outBuffer
      this.outBuffer = Buffer.alloc(0)

      if (this.operationOngoing === OperationType.none) {
        this.processNextOperation()
      }
    }
  }

  private onStderr(data: Buffer): void {
    console.log(`stderr: ${data.toString("utf-8")}`)
    this.err(data)
  }

  private onExit(code: number, signal: string): void {
    this.pipeConnected = false
    this.exit(code, signal)
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

  private runCommand(command: Command, operationType: OperationType): boolean {
    if (
      !this.pipeConnected ||
      // operation must not be marked as ongoing before sending the command
      this.operationOngoing !== OperationType.none
    ) {
      return false
    }

    // set operation type so that the stdout handler knows what to do
    this.operationOngoing = operationType

    /*this.proc.send(...)*/

    // start operation
    let errOccured = false
    this.proc.stdin.write(JSON.stringify(command) + "\n", (err) => {
      errOccured = err instanceof Error
    })

    return !errOccured
  }

  private addOperation(op: PyOperation): void {
    this.operationQueue.push(op)
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

    const op: PyOperation | undefined = this.operationQueue.shift()
    if (op) {
      op.callback(this.runCommand.bind(this))
    }
  }

  /**
   * Executes a command on the remote host
   *
   * @param command The command to be executed on the remote host
   * @returns If the operation was successfully started
   */
  public executeCommand(command: string): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "command",
            args: {
              command: command,
            },
          },
          OperationType.command
        )
      },
    })
  }

  /**
   * Lists the contents of a directory on the remote host (non-recursive)
   *
   * @param remotePath The path on remote to directory to be scaned
   * @returns If the operation was successfully started
   */
  public listContents(remotePath: string): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "list_contents",
            args: {
              target: remotePath,
            },
          },
          OperationType.listContents
        )
      },
    })
  }

  /**
   * Uploads files to the remote host
   *
   * @param files The files to upload. If count is 1, the local or remote path
   * CAN be used as target file or folder
   * @param target The target folder. If files count is 1, this can be used as target
   * @returns If the operation was successfully started
   */
  public uploadFiles(files: string[], target: string): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "upload_files",
            args: {
              files: files,
              remote: target,
            },
          },
          OperationType.uploadFiles
        )
      },
    })
  }

  /**
   * Downloads files from the remote host
   *
   * @param files The files to download. If count is 1, the local or remote path
   * CAN be used as target file or folder
   * @param target The target folder. If files count is 1, this can be used as local target file
   * @returns If the operation was successfully started
   */
  public downloadFiles(files: string[], target: string): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "download_files",
            args: {
              files: files,
              local: target,
            },
          },
          OperationType.downloadFiles
        )
      },
    })
  }

  /**
   * Deletes files on the remote host
   * (Pyboard tool does only process one delete file request at a time
   * so this is not a batch operation but it is still faster than calling
   * deleteFile multiple times)
   *
   * @param files The files on the remote to delete. Does not require ':' prefix
   */
  public deleteFiles(files: string[]): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "delete_files",
            args: {
              files: files,
            },
          },
          OperationType.deleteFiles
        )
      },
    })
  }

  /**
   * Creates folders on the remote host
   *
   * @param folders The folders to create on the remote host
   * @returns If the operation was successfully started
   */
  public createFolders(folders: string[]): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "mkdirs",
            args: {
              folders: folders,
            },
          },
          OperationType.createFolders
        )
      },
    })
  }

  /**
   * Deletes folders on the remote host
   *
   * @param folders The folders on the remote to delete. Does not require ':' prefix
   * @returns If the operation was successfully started
   */
  public deleteFolders(folders: string[]): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "rmdirs",
            args: {
              folders: folders,
            },
          },
          OperationType.deleteFolders
        )
      },
    })
  }

  /**
   * Deletes a folder and all its contents on the remote host
   *
   * @param folder The folder on the remote to delete. Does not require ':' prefix
   * @returns If the operation was successfully started
   */
  public deleteFolderRecursive(folder: string): void {
    if (!this.pipeConnected) {
      return
    }

    this.addOperation({
      callback: (runCommand) => {
        runCommand(
          {
            command: "rmtree",
            args: {
              folders: [folder],
            },
          },
          OperationType.deleteFolderRecursive
        )
      },
    })
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
