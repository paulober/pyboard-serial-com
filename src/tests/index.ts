import { exit } from "process"
import { PyboardRunner } from "../pyboardRunner.js"
import { PyOutType } from "../pyout.js"
import type {
  PyOut,
  PyOutListContents,
  PyOutCommandResult,
  PyOutCommandWithResponse,
  PyOutGetItemStat,
  PyOutRtcTime,
  PyOutStatus,
  PyOutTabComp,
} from "../pyout.js"

const pyboardRunner = new PyboardRunner(
  "/dev/cu.usbserial-0001",
  115200,
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
  }
)

function processStat(result: PyOut): void {
  if (result.type === PyOutType.getItemStat) {
    const itemStat = (result as PyOutGetItemStat).stat
    if (itemStat === null) {
      console.error("Item not found!")
    } else {
      console.log("Stat: " + JSON.stringify(itemStat))
    }
  }
}

process.stdin.on("data", async (data: Buffer) => {
  await pyboardRunner.writeToPyboard(data.toString("utf-8"))
})

setTimeout(async () => {
  console.log("===== Adding all operations!")

  //await PyboardRunner.getPorts()

  /*const interval = setInterval(async () => {
    if (pyboardRunner.isPipeConnected()) {
      console.log("Connected")
    } else {
      console.log("Not connected")
    }
    await pyboardRunner.checkStatus()
  }, 2500)*/
  /*let data = await pyboardRunner.runFile(
    "/Users/paulober/PicoDev/test/main.py",
    (data: string) => {
      if (data.includes("!!ERR!!")) {
        console.log("IsPipeConnected: " + pyboardRunner.isPipeConnected())

        return
      }
      console?.log(data)
    }
  )
  console.log("Run file result: " + JSON.stringify(data))*/
  let data = await pyboardRunner.executeCommand(
    "print('Hello world!'+str(1+2))"
  )
  if (data.type === PyOutType.commandWithResponse) {
    const result = data as PyOutCommandWithResponse
    console.log(`Command result: ${result.response}`)
  }
  /*data = await pyboardRunner.retrieveTabCompletion("uos.")
  if (data.type === PyOutType.tabComp) {
    const result = data as PyOutTabComp
    console.log(
      `Tab completion (before uos import): IsSimple: ${result.isSimple} | ` +
        result.completion
    )
  }
  data = await pyboardRunner.executeCommand("import uos")
  if (data.type === PyOutType.commandWithResponse) {
    const result = data as PyOutCommandWithResponse
    console.log(`Command result: ${result.response}`)
  }
  data = await pyboardRunner.retrieveTabCompletion("uos.")
  if (data.type === PyOutType.tabComp) {
    const result = data as PyOutTabComp
    console.log(
      `Tab completion (after uos import): IsSimple: ${result.isSimple} | ` +
        result.completion
    )
  }
  data = await pyboardRunner.retrieveTabCompletion("uos.l")
  if (data.type === PyOutType.tabComp) {
    const result = data as PyOutTabComp
    console.log(
      `Tab completion (for uos.l): IsSimple: ${result.isSimple} | ` +
        result.completion
    )
  }
  data = await pyboardRunner.startUploadingProject(
    "/Users/paulober/PicoDev/test",
    ["py", "txt", "log", "json", "xml", "html", "js", "css", "mpy"],
    [
      ".picowgo",
      ".vscode",
      ".gitignore",
      ".git",
      "project.pico-go",
      "env",
      "venv",
    ],
    (data: string) => {
      console.log("Follow: ", data)
    }
  )
  /*data = await pyboardRunner.downloadProject(
    "/Users/paulober/PicoDev/test/project-one",
    data => {
      console.log("Follow: ", data)
    }
  )*/
  await pyboardRunner.deleteFolderRecursive("/")
  data = await pyboardRunner.startUploadingProject(
    "/Users/paulober/PicoDev/test/default-project",
    //["py"],
    //["sub/subi.py", "sub/sub3"],
    ["py", "txt", "log", "json", "xml", "html", "js", "css", "mpy"],
    [
      "**/.picowgo",
      "**/.micropico",
      "**/.DS_Store",
      "**/.picowgo",
      "**/.vscode",
      "**/.gitignore",
      "**/.git",
      "**/project.pico-go",
      "**/env",
      "**/venv",
      "sub/subi.py",
      "sub/sub3/thefiles5.py",
    ],
    (data: string) => {
      console.log("Follow: ", data)
    }
  )
  console.log("Upload/Download project result: " + JSON.stringify(data))
  data = await pyboardRunner.listContents("/")
  await listDataCp(data)
  data = await pyboardRunner.listContents("/sub")
  await listDataCp(data)
  /*data = await pyboardRunner.sendCtrlD((data: string) => {
    process.stdout.write(data)
  })
  console.log("Ctrl+D result: " + JSON.stringify(data))*/
  /*data = await pyboardRunner.sendCtrlD((data: string) => {
    //console.log(data)
    process.stdout.write(data)
  })
  console.log("Ctrl+D result: " + JSON.stringify(data))*/
  //data = await pyboardRunner.hardReset()
  //console.log("Hard reset without follow result: " + JSON.stringify(data))

  return

  const result123 = await pyboardRunner.softReset()
  console.log("Soft reset result: " + JSON.stringify(result123))

  //pyboardRunner.listContents("/").then(listDataCp)
  //await PyboardRunner.getPorts()
  let result = await pyboardRunner.getItemStat("/example.py")
  processStat(result)
  result = await pyboardRunner.getItemStat("/test123")
  processStat(result)
  result = await pyboardRunner.getItemStat("/example123.py")
  processStat(result)

  result = await pyboardRunner.renameItem("/example.py", "/example123.py")
  console.log("Rename result: " + JSON.stringify(result))
  result = await pyboardRunner.getItemStat("/example123.py")
  processStat(result)
  result = await pyboardRunner.renameItem("/example123.py", "/example.py")
  console.log("Rename back result: " + JSON.stringify(result))
  result = await pyboardRunner.getItemStat("/example123.py")
  processStat(result)

  result = await pyboardRunner.getRtc()
  if (result.type === PyOutType.getRtcTime) {
    const rtcTime = (result as PyOutRtcTime).time
    if (rtcTime !== null) {
      console.log(
        "RTC time: " +
          rtcTime?.toLocaleDateString() +
          " " +
          rtcTime?.toLocaleTimeString()
      )
    } else {
      console.error("RTC time is null!")
    }
  }
  result = await pyboardRunner.syncRtc()
  if (result.type === PyOutType.status) {
    const commandResult = (result as PyOutStatus).status
    console.log("Sync RTC result: " + commandResult)
  }
  result = await pyboardRunner.getRtc()
  if (result.type === PyOutType.getRtcTime) {
    const rtcTime = (result as PyOutRtcTime).time
    if (rtcTime !== null) {
      console.log(
        "RTC time: " +
          rtcTime?.toLocaleDateString() +
          " " +
          rtcTime?.toLocaleTimeString()
      )
    } else {
      console.error("RTC time is null!")
    }
  }

  result = await pyboardRunner.createFolders(["/test_rm"])
  if (result.type === PyOutType.status) {
    const commandResult = (result as PyOutStatus).status
    console.log("Create folders result: " + commandResult)
  }
  result = await pyboardRunner.deleteFileOrFolder("/test_rm", true)
  if (result.type === PyOutType.status) {
    const commandResult = (result as PyOutStatus).status
    console.log("Delete file or folder result: " + commandResult)
  }
  await pyboardRunner.listContentsRecursive("/").then(listDataCp)

  console.log("===== Finished adding all operations!")
}, 700)

async function listDataCp(data: PyOut): Promise<void> {
  if (data.type === PyOutType.listContents) {
    const contents = data as PyOutListContents
    contents.response.forEach(file => {
      console.log(
        `${file.isDir ? "Directory" : "File"}: ${file.path} (${
          file.size
        } bytes)`
      )
    })
  }
}

process.on("SIGINT", () => {
  console.log("Caught interrupt signal")
  pyboardRunner.disconnect()
  process.exit()
}) /*(async function () {
  let i = 2
  while (i > 0) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    i--
  }
  pyboardRunner.switchDevice("COM3")
  setTimeout(async () => {
    /*pyboardRunner.deleteFolderRecursive("/").then((data: PyOut) => {
      if (data.type === PyOutType.status) {
        const result = data as PyOutStatus
        console.log(`Delete folder status: ${result.status}`)
      }
    })

    pyboardRunner.listContentsRecursive("/").then(listDataCp)

    // await to avoid download will be runn after calc hashes but before upload
    const uploadResult = await pyboardRunner.startUploadingProject(
      "N:\\pyboard-serial-com\\scripts\\test",
      [],
      ["N:\\pyboard-serial-com\\scripts\\test\\downloads"],
      (data: string) => {
        try {
          const json = JSON.parse(data)
          if ("error" in json) {
            console.log(`Calc hash error: ${json.file}`)
          }
        }
        catch (e) {
          if (data.endsWith("%")) {
            console.log(data)
          }
        }
      }
    )
    if (uploadResult.type === PyOutType.status) {
      const result = uploadResult as PyOutStatus
      console.log(`Upload project status: ${result.status}`)
    }

    pyboardRunner.listContentsRecursive("/").then(listDataCp)

    pyboardRunner.downloadProject(
      "N:\\pyboard-serial-com\\scripts\\test\\downloads",
      (data: string) => {
        console.log(data)
      }
    ).then((data: PyOut) => {
      if (data.type === PyOutType.status) {
        const result = data as PyOutStatus
        console.log(`Download project status: ${result.status}`)
      }
    })*/
/*
// Friendly command test
process.stdin.on("data", async (data: Buffer) => {
  await pyboardRunner.writeToPyboard(data.toString("utf-8"))
}) 
/*
    //"a='asd'\na\n",
    //"a=0\nwhile a < 2:\n    b=input('Inp: ')\n    b\n    a+=1",
    pyboardRunner
      .executeFriendlyCommand(
        "input('Inp: '); print('asd')",
        (data: string) => {
          // does work in vscode only with launch config edit
          process.stdout.write(data)
        }
      )
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`Command result: ${result.result}`)
        }
      })*/
/*
    pyboardRunner
      .runFile(
        "N:\\pyboard-serial-com\\scripts\\test\\im_test.py",
        (data: string) => {
          // does work in vscode only with launch config edit
          process.stdout.write(data)
        }
      )
      .then((data: PyOut) => {
        if (data.type === PyOutType.commandResult) {
          const result = data as PyOutCommandResult
          console.log(`File run result: ${result.result}`)
        }
      })

    pyboardRunner.softReset(true).then((data: PyOut) => {
      if (data.type === PyOutType.commandWithResponse) {
        const result = data as PyOutCommandWithResponse
        console.log(`Soft reset response: \n${result.response}`)
      } else if (data.type === PyOutType.commandResult) {
        const result = data as PyOutCommandResult
        console.log(`Soft reset result: ${result.result}`)
      }
    })

    pyboardRunner.hardReset().then((data: PyOut) => {
      if (data.type === PyOutType.commandResult) {
        const result = data as PyOutCommandResult
        console.log(`Hard reset result: ${result.result}`)
      }
    })

    pyboardRunner.listContents("/").then(listDataCp)
  }, 300)
})()*/
;(async function () {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})()
