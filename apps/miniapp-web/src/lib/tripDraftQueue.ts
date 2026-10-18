/** Per-record acknowledgements; a late response can never change another record's revision. */
export class TripDraftQueue {
  private tails = new Map<string,Promise<unknown>>();
  private revisions = new Map<string,number>();
  private failures = new Map<string,unknown>();
  remember(id:string,revision:number) { this.revisions.set(id,revision); }
  revision(id:string) { return this.revisions.get(id) ?? 0; }
  enqueue<T>(id:string,job:(base:number)=>Promise<{revision:number;value?:T}>):Promise<T|undefined> {
    const task=(this.tails.get(id)??Promise.resolve()).then(async()=> {
      if(this.failures.has(id))throw this.failures.get(id);
      const r=await job(this.revision(id));
      this.revisions.set(id,r.revision);
      return r.value;
    });
    this.tails.set(id,task.catch(e=>{this.failures.set(id,e);}));
    return task;
  }
  async flush(id?:string) {
    await Promise.all(id ? [this.tails.get(id)] : [...this.tails.values()]);
    if(id && this.failures.has(id))throw this.failures.get(id);
    if(!id && this.failures.size)throw [...this.failures.values()][0];
  }
  retry(id:string) { this.failures.delete(id); }
}
