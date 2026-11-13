import type {ThermalConfig,ThermalSurface} from './thermal.js';
/** Validated budgets include failed proposals and repairs. */
export type OptimizationPolicy={maxAttempts:number;maxRepairsPerCandidate:number;timeBudgetMs:number;massRatio:number;significantImprovementC:number;stagnationCandidates:number;verificationMeshFactor:number};
export type OptimizationPhase='preparing'|'awaiting_proposal'|'claimed'|'building'|'inspecting'|'solving'|'verifying'|'completed'|'no_improvement'|'cancelled'|'failed'|'interrupted'|'unverified';
export type OptimizationMetrics={maximumC:number;massKg:number};
export type OptimizationCandidate={id:string;attempt:number;state:'proposed'|'building'|'inspecting'|'solving'|'valid'|'invalid'|'interrupted';rationale:string;changes:string[];code?:string;codeSource?:string;source?:string;sourceHash?:string;buildId?:string;inspectionId?:string;runId?:string;maximumC?:number;massKg?:number;warnings?:string[];error?:string;repairOf?:string;token?:string;sessionId?:string;childId?:string;verificationRunId?:string;verificationRunIds?:string[]};
export type GeometryEvidence={bounds:number[];volumeM3:number;holes:number[][]};
/** Persisted outside the model workspace; only the backend writes task facts. */
export type OptimizationTask={id:string;sourceProjectId:string;projectId:string;workspacePath:string;revision:number;phase:OptimizationPhase;policy:OptimizationPolicy;createdAt:string;updatedAt:string;deadlineAt:string;remainingTimeMs?:number;candidates:OptimizationCandidate[];baseline:OptimizationMetrics&{source:string;code:string;runId:string;sourceHash:string;buildId:string;geometry:GeometryEvidence;surface:ThermalSurface;config:ThermalConfig;units:'mm'|'cm'|'m';inspectionId?:string;verificationRunId?:string;verificationRunIds?:string[];verifiedMaximumC?:number};bestCandidateId?:string;stopReason?:string;error?:string;sessionId?:string;claim?:{token:string;attempt:number;workerId:string;sessionId:string};stagnation:number;verification?:{baselineMaximumC:number;candidateMaximumC:number;meshSizeM:number;improvementC:number}};


/** Default budgets used by the REST service and policy editor. */
export const DEFAULT_OPTIMIZATION_POLICY:Readonly<OptimizationPolicy>={maxAttempts:6,maxRepairsPerCandidate:1,timeBudgetMs:1800000,massRatio:1.05,significantImprovementC:0.2,stagnationCandidates:3,verificationMeshFactor:0.75};
