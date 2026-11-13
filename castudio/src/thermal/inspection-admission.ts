/** Publish ownership synchronously after admission, or await cancellation for an obsolete view. */
export async function ownInspection<T>(start:Promise<T>,isCurrent:()=>boolean,onOwned:(record:T)=>void,cancel:(record:T)=>Promise<unknown>):Promise<T|null>{
  const record=await start;
  if(!isCurrent()){
    await cancel(record);
    return null;
  }
  onOwned(record);
  return record;
}
