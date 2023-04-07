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
  ports: string[]
}

export interface PyOutGetItemStat extends PyOut {
  type: PyOutType.getItemStat
  stat: PyFileData | null
}

export interface PyOutRtcTime extends PyOut {
  type: PyOutType.getRtcTime
  time: Date | null
}
