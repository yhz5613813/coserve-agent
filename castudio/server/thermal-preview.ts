import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {ThermalPreview} from '../shared/thermal.js';
import {HttpError,safePath} from './storage.js';

const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const temperature={type:'number'};
const validate=new Ajv2020().compile<ThermalPreview>({
  type:'object',additionalProperties:false,
  required:['schema_version','source_sha256','geometry_sha256','vertices','analysis_mode','frames'],
  properties:{schema_version:{const:1},source_sha256:digest,geometry_sha256:digest,
    vertices:{type:'integer',minimum:1,maximum:33554432},analysis_mode:{enum:['steady','transient']},
    frames:{type:'array',minItems:1,maxItems:512,items:{type:'object',additionalProperties:false,
      required:['time_s','minimum_C','maximum_C','average_C','sha256'],
      properties:{time_s:{type:'number',minimum:0},minimum_C:temperature,maximum_C:temperature,average_C:temperature,sha256:digest}}}},
});

/** Read one committed index; a missing index means the solver has not saved its first frame. */
export async function readThermalPreview(folder:string,sourceHash:string):Promise<ThermalPreview|undefined>{
  let bytes:Buffer;
  try{bytes=await fs.readFile(await safePath(folder,'index.json'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(bytes.length>512*1024)throw new Error('实时预览索引过大');
  const value:unknown=JSON.parse(bytes.toString('utf8'));
  if(!validate(value))throw new Error('实时预览数据格式无效');
  if(value.source_sha256!==sourceHash)throw new Error('实时预览与当前任务模型不匹配');
  let previous=-1;
  for(const row of value.frames){
    if(row.time_s<=previous||row.minimum_C>row.maximum_C||row.average_C<row.minimum_C-1e-4||row.average_C>row.maximum_C+1e-4)
      throw new Error('实时预览的时间或温度统计无效');
    previous=row.time_s;
  }
  return value;
}

/** Serve only a fixed geometry or indexed frame, after checking size and its committed hash. */
export async function thermalPreviewBytes(folder:string,file:string,expectedHash:string,expectedBytes?:number):Promise<Buffer>{
  const target=await safePath(folder,file),stat=await fs.stat(target);
  if(!stat.isFile()||stat.size>128*1024*1024||(expectedBytes!==undefined&&stat.size!==expectedBytes))
    throw new HttpError(409,'实时预览文件大小已变化');
  const bytes=await fs.readFile(target);
  if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)
    throw new HttpError(409,'实时预览文件摘要已变化');
  return bytes;
}
