import { PyboardRunner } from "../pyboardRunner"
import { PyOutType } from "../pyout"
import type {
  PyOut,
  PyOutListContents,
  PyOutFsOps,
} from "../pyout"

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
  let i = 10
  while (i > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    i--
  }
  pyboardRunner.switchDevice("COM4")
  setTimeout(async () => {
    pyboardRunner.deleteFolderRecursive("/").then((data: PyOut) => {
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
    })
  }, 700)
})()
;(async function () {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})()
