import assert from 'node:assert/strict';
const base=process.env.TEST_URL||'http://127.0.0.1:5173',stamp=crypto.randomUUID(),password='Test-'+crypto.randomUUID();
function client(){let cookie='';return async(path,method='GET',body,expected=200)=>{
 const r=await fetch(`${base}/api/${path}`,{method,headers:{cookie,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
 if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
 const data=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;
}}
const admin=client(),manager=client(),a=client(),b=client(),other=client();
await admin('auth/register','POST',{name:'Lifecycle',company:'Lifecycle '+stamp,email:`admin-${stamp}@test.local`,password,demo:true},201);
const createUser=async(name)=>admin('users','POST',{name,email:`${name}-${stamp}@test.local`,password,role:name==='manager'?'manager':'employee'},201);
const ua=await createUser('a'),ub=await createUser('b');await createUser('manager');
for(const [c,name] of [[a,'a'],[b,'b'],[manager,'manager']])await c('auth/login','POST',{email:`${name}-${stamp}@test.local`,password});
await other('auth/register','POST',{name:'Other',company:'Other',email:`other-${stamp}@test.local`,password},201);
const createTask=async(ids=[ua.id,ub.id])=>admin('tasks','POST',{title:'Lifecycle task',description:'Check statuses and deletion',assignee_ids:ids,deadline:new Date(Date.now()+86400000).toISOString(),priority:'normal',points:40},201);
const task=await createTask();
await other('tasks/'+task.id+'/status','PATCH',{status:'done'},404);
await other('tasks/'+task.id,'DELETE',{},404);
await a('tasks/'+task.id,'DELETE',{},403);
await a('tasks/'+task.id+'/status','PATCH',{status:'done'},409);
await manager('tasks/'+task.id+'/status','PATCH',{status:'overdue'},400);
for(const status of ['review','new','progress']){
 await manager('tasks/'+task.id+'/status','PATCH',{status});
 const detail=await b('tasks/'+task.id);assert.equal(detail.status,status);assert(detail.activity.some(x=>x.body.includes('Изменил(а) статус')));
 assert.equal((await a('state')).me.points,0);
}
await manager('tasks/'+task.id+'/status','PATCH',{status:'done'});
assert.equal((await a('state')).me.points,40);assert.equal((await b('state')).me.points,40);
assert.equal((await a('tasks/'+task.id)).status,'done');
// Reopening, changing points and reapproving cannot award the same person twice.
await manager('tasks/'+task.id+'/status','PATCH',{status:'new'});
await admin('tasks/'+task.id,'PATCH',{points:80,assignee_ids:[ub.id,ua.id]});
await manager('tasks/'+task.id+'/status','PATCH',{status:'review'});
await Promise.all([manager('tasks/'+task.id+'/approve','POST',{}),admin('tasks/'+task.id+'/status','PATCH',{status:'done'}).catch(err=>assert.match(err.message,/409/))]);
assert.equal((await a('state')).me.points,40);assert.equal((await b('state')).me.points,40);
let state=await admin('state');assert.equal(state.ledger.filter(l=>l.reference?.startsWith(task.id+':')).length,2);
assert(state.notifications.some(n=>n.title.includes('Ожидает проверки')));
// Old single-assignee ledger references also prevent repeat awards.
const legacy=state.tasks.find(t=>t.status==='done'&&t.id!==task.id),legacyUser=state.users.find(u=>u.id===legacy.assignee_id);
await manager('tasks/'+legacy.id+'/status','PATCH',{status:'progress'});
await manager('tasks/'+legacy.id+'/status','PATCH',{status:'done'});
state=await admin('state');assert.equal(state.users.find(u=>u.id===legacyUser.id).points,legacyUser.points);
assert.equal(state.ledger.filter(l=>l.reference===legacy.id||l.reference?.startsWith(legacy.id+':')).length,1);
// Deletion hides all task content and reports while preserving earned points.
const file=new FormData();file.append('file',new File(['Test'], 'result.txt',{type:'text/plain'}));
await b('tasks/'+task.id+'/attachments','POST',file,201);
const attachment=(await b('tasks/'+task.id)).attachments[0];
await manager('tasks/'+task.id,'DELETE',{});
await admin('tasks/'+task.id,'GET',null,404);await a('tasks/'+task.id,'GET',null,404);
await manager('tasks/'+task.id+'/status','PATCH',{status:'new'},404);
await admin('tasks/'+task.id,'PATCH',{title:'Cannot restore'},404);
await b('tasks/'+task.id+'/comments','POST',{body:'No access'},404);
await b('files/'+attachment.id,'GET',null,404);
await manager('tasks/'+task.id,'DELETE',{},404);
state=await admin('state');assert(!state.tasks.some(t=>t.id===task.id));assert(!state.notifications.some(n=>n.task_id===task.id));
assert.equal((await a('state')).me.points,40);assert.equal((await b('state')).me.points,40);
assert.equal((await admin('rating?period=all')).find(u=>u.id===ua.id).earned,40);
assert.equal((await admin('rating?period=all')).find(u=>u.id===ua.id).completed,0);
const unpaid=await createTask();await admin('tasks/'+unpaid.id,'DELETE',{});
assert.equal((await a('state')).me.points,40);
console.log('PASS: manager status selection, employee/company permissions, reopening and legacy awards without duplicates, deletion, files access, notifications and preserved points.');
