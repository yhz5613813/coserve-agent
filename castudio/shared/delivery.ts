/** A final recommendation is a verified candidate or the unchanged baseline. */
export type DeliverySelection={kind:'verified_candidate'|'baseline';candidateId?:string;sourceHash:string;runId:string};
/** Immutable export inventory. The ZIP checksum lives outside the ZIP to avoid a circular digest. */
export type DeliveryRecord={schemaVersion:1;id:string;taskId:string;taskRevision:number;phase:string;createdAt:string;selected:DeliverySelection;archive:{size:number;sha256:string};files:{path:string;size:number;sha256:string}[]};
