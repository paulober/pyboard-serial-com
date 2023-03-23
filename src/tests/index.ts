import { PyboardRunner, SCAN_DEVICE } from "../pyboardRunner"
import { PyOutType } from "../pyout"
import type {
  PyOut,
  PyOutListContents,
  PyOutCommand,
  PyOutFsOps,
  PyOutPortsScan,
} from "../pyout"

const pyboardRunner = new PyboardRunner(
  SCAN_DEVICE,
  async (data: PyOut) => {
    if (data.type === PyOutType.listContents) {
      const contents = data as PyOutListContents

      //console.log(contents.response)
      contents.response.forEach((file) => {
        console.log(`File: ${file.path} (${file.size} bytes)`)
      })
    } else if (data.type === PyOutType.command) {
      console.log(`Command response: ${(data as PyOutCommand).response}`)
    } else if (data.type === PyOutType.fsOps) {
      console.log(
        "Filesystem operation status: " +
          ((data as PyOutFsOps).status ? "Done" : "Failure")
      )
    } else if (data.type === PyOutType.portsScan) {
      // print all ports
      console.debug("\nPorts found:")
      ;(data as PyOutPortsScan).ports.forEach((port: string) => {
        console.debug(`Port: ${port}`)
      })
    } else {
      console.log(`stdout: ${data}`)
    }
  },
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
setTimeout(() => {
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

  /*pyboardRunner.listContents("/")
    pyboardRunner.createFolders(["test", "test2"])
    pyboardRunner.listContents("/")
    pyboardRunner.deleteFolders(["test", "test2"])
    pyboardRunner.listContents("/")*/

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
    pyboardRunner.listContents("/")
    pyboardRunner.startUploadingProject(
      "N:\\pyboard-serial-com\\scripts\\test",
      [".py"],
      []
    )
  }, 700)
})()
;(async function () {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})()
