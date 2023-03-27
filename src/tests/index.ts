import { PyboardRunner, SCAN_DEVICE } from "../pyboardRunner"
import { PyOutType } from "../pyout"
import type {
  PyOut,
  PyOutListContents,
  PyOutCommandResult,
  PyOutCommandWithResponse,
  PyOutFsOps,
  PyOutPortsScan,
} from "../pyout"

const pyboardRunner = new PyboardRunner(
  SCAN_DEVICE,
  (data: Buffer | undefined) => {
    if (data !== undefined) {
      console.log(`stderr: ${data?.toString()}`)
    } else {
      // connected sucessfully
      console.log("Connected!")
    }
  },
  (code: number, signal: string) => {
    if (code) {
      console.debug(`child process exited with code ${code}`)
    }
    if (signal) {
      console.debug(`child process killed with signal ${signal}`)
    }
    console.debug("Done - exit")
  },
  "python"
)

//console.log(`Waiting for process to start: ${pyboardRunner.isConnected()}`)
//pyboardRunner.stop()
//while (pyboardRunner.proc.connected) {}
setTimeout(async () => {
  //console.log(pyboardRunner.executeCommand("print('Hello World')"))
  //console.log(pyboardRunner.listContents("/"))
  /*console.log(
        pyboardRunner.downloadFiles(
            [":project.pico-w-go", ":list_avail_modules.py"], 
            "C:\\Users\\paulo\\Downloads\\"))*/
  /*pyboardRunner.uploadFiles(
        ["C:\\Users\\paulo\\Downloads\\tesf.txt",
        "C:\\Users\\paulo\\Downloads\\anders.py"],
        ":")*/

  //pyboardRunner.deleteFiles(["tesf.txt", "anders.py"])

  //pyboardRunner.createFolders(["test", "test2"])
  //pyboardRunner.listContents("/")
  //pyboardRunner.deleteFolders(["test", "test2"])
  //pyboardRunner.listContents("/")

  /* Works!!
    pyboardRunner.createFolders(["test"])
    pyboardRunner.listContents("/")
    pyboardRunner.listContents("/test")
    pyboardRunner.uploadFiles(["C:\\Users\\paulo\\Downloads\\test.txt"], ":test/")
    pyboardRunner.listContents("/test")
    pyboardRunner.deleteFolderRecursive("/test")
    pyboardRunner.listContents("/")*/

  //pyboardRunner.listContents("/")

  console.log("===== Finished adding all operations!")
}, 700)

async function listDataCp(data: PyOut): Promise<void> {
  if (data.type === PyOutType.listContents) {
    const contents = data as PyOutListContents
    contents.response.forEach((file) => {
      console.log(
        `${file.isDir ? "Directory" : "File"}: ${file.path} (${
          file.size
        } bytes)`
      )
    })
  }
}

async function friendlyCommandCb(data: string): Promise<void> {
  // vscode debugging console doesn't show stdout, so we need to use console.log
  if (process.env.v8debug !== undefined) {
    console.log(data)
  }
  else {
    process.stdout.write(data)
  }
}

process.on("SIGINT", () => {
  console.log("Caught interrupt signal")
  pyboardRunner.disconnect()
  process.exit()
})
;(async function () {
  let i = 10
  while (i > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    i--
  }
  pyboardRunner.switchDevice("COM3")
  setTimeout(() => {
    pyboardRunner.listContents("/").then(listDataCp)
    pyboardRunner.createFolders(["test9", "atest9"]).then((data: PyOut) => {
      if (data.type === PyOutType.fsOps) {
        const result = data as PyOutFsOps
        console.log(`Create folder status: ${result.status}`)
      }
    })
    pyboardRunner.listContents("/").then(listDataCp)
    pyboardRunner.deleteFolders(["test9", "atest9"]).then((data: PyOut) => {
      if (data.type === PyOutType.fsOps) {
        const result = data as PyOutFsOps
        console.log(`Delete folder status: ${result.status}`)
      }
    })
    pyboardRunner.listContents("/").then(listDataCp)
    /*pyboardRunner.startUploadingProject(
      "N:\\pyboard-serial-com\\scripts\\test",
      [".py"],
      []
    )*/
    pyboardRunner
      .executeFriendlyCommand("print('Hello World')", friendlyCommandCb)
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`Friendly Command result: ${result.result}`)
        }
      })
    pyboardRunner
      .executeFriendlyCommand("a=2", friendlyCommandCb)
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`Friendly Command result: ${result.result}`)
        }
      })
    pyboardRunner
      .executeFriendlyCommand("a", friendlyCommandCb)
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`Friendly Command result: ${result.result}`)
        }
      })
    pyboardRunner
      .executeFriendlyCommand("while a < 50: print(a); a+=1", friendlyCommandCb)
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`Friendly Command result: ${result.result}`)
        }
      })
  }, 700)
})()
;(async function () {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})()
