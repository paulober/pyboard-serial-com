import type PyFileData from "./pyfileData.js"

export enum PyOutType {
  none,
  portsScan,
  commandWithResponse,
  commandResult,
  listContents,
  status,
  getItemStat,
  getRtcTime,
  tabComp,
}

export interface PyOut {
  type: PyOutType
}

export interface PyOutCommandWithResponse extends PyOut {
  type: PyOutType.commandWithResponse
  response: string
}

export interface PyOutCommandResult extends PyOut {
  type: PyOutType.commandResult
  result: boolean
}

export interface PyOutListContents extends PyOut {
  type: PyOutType.listContents
  response: PyFileData[]
}

export interface PyOutStatus extends PyOut {
  type: PyOutType.status
  /**
   * True menas operation was successful and false means it failed
   */
  status: boolean
}

export interface PyOutPortsScan extends PyOut {
  type: PyOutType.portsScan
  ports: Array<{ port: string; baud: number }>
}

export interface PyOutGetItemStat extends PyOut {
  type: PyOutType.getItemStat
  stat: PyFileData | null
}

export interface PyOutRtcTime extends PyOut {
  type: PyOutType.getRtcTime
  time: Date | null
}

export interface PyOutTabComp extends PyOut {
  type: PyOutType.tabComp
  /**
   * Simple completion is when there is only one completion option so the command
   * extended with the completion will be returned, not only the completion.
   *
   * Also if it's simple it will not end with a newline.
   */
  isSimple: boolean
  completion: string
}
