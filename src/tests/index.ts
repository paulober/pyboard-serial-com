import { PyboardRunner } from "../pyboardRunner"
import { PyOutType } from "../pyout"
import type { PyOut, PyOutListContents, PyOutCommandResult } from "../pyout"

const pyboardRunner = new PyboardRunner(
  "COM3",
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

setTimeout(async () => {
  console.log("===== Adding all operations!")

  pyboardRunner.listContents("/").then(listDataCp)

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

process.on("SIGINT", () => {
  console.log("Caught interrupt signal")
  pyboardRunner.disconnect()
  process.exit()
})
;(async function () {
  let i = 2
  while (i > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    i--
  }
  pyboardRunner.switchDevice("COM3")
  setTimeout(async () => {
    /*pyboardRunner.deleteFolderRecursive("/").then((data: PyOut) => {
      if (data.type === PyOutType.fsOps) {
        const result = data as PyOutFsOps
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
    if (uploadResult.type === PyOutType.fsOps) {
      const result = uploadResult as PyOutFsOps
      console.log(`Upload project status: ${result.status}`)
    }

    pyboardRunner.listContentsRecursive("/").then(listDataCp)

    pyboardRunner.downloadProject(
      "N:\\pyboard-serial-com\\scripts\\test\\downloads",
      (data: string) => {
        console.log(data)
      }
    ).then((data: PyOut) => {
      if (data.type === PyOutType.fsOps) {
        const result = data as PyOutFsOps
        console.log(`Download project status: ${result.status}`)
      }
    })*/

    // Friendly command test
    /*process.stdin.on("data", async (data: Buffer) => {
      await pyboardRunner.writeToPyboard(data.toString("utf-8"))
    })
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
  }, 300)
})()
;(async function () {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})()
