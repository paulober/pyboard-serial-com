import type PyFileData from "./pyfileData.js"

export enum PyOutType {
    none,
    portsScan,
    commandWithResponse,
    commandResult,
    listContents,
    fsOps
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

export interface PyOutFsOps extends PyOut {
    type: PyOutType.fsOps,
    status: boolean
}

export interface PyOutPortsScan extends PyOut {
    type: PyOutType.portsScan
    ports: string[]
}
