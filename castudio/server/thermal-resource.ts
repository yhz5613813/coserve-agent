import {HttpError} from './storage.js';

/** One CPU meshing/solve owner, shared by thermal jobs and editor inspections. */
export class ThermalResource {
  private owned=false;
  get busy(){return this.owned;}
  acquire(){
    if(this.owned)throw new HttpError(409,'已有热仿真或几何检查正在运行，请等待或取消');
    this.owned=true;let released=false;
    return()=>{if(!released){released=true;this.owned=false;}};
  }
}
