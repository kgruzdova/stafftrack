type Row = Record<string, any>;
export type TaskContext = {
  q: (sql: string, ...args: any[]) => D1PreparedStatement;
  all: (sql: string, ...args: any[]) => Promise<Row[]>;
  db: () => D1Database;
  fail: (status: number, message: string) => never;
};
const names: Record<string, string> = {new: 'Новая', progress: 'В работе', review: 'На проверке', done: 'Выполнена'};
const isManager = (u: Row) => ['admin', 'manager'].includes(u.role);

// The first statement records the operation only if the observed task is still
// current. Every subsequent statement uses this receipt inside one transaction.
function receipt(c: TaskContext, u: Row, t: Row, operation: string, stamp: string, text: string) {
  return c.q('INSERT INTO activity (id,task_id,user_id,body,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND company_id=? AND status=? AND deleted_at IS NULL)', operation, t.id, u.id, text, stamp, t.id, u.company_id, t.status);
}
const guard = 'EXISTS (SELECT 1 FROM activity WHERE id=?)';

export async function completeTask(c: TaskContext, u: Row, t: Row) {
  if (!isManager(u)) c.fail(403, 'Доступно только руководителю');
  if (t.status === 'done') return {ok: true};
  const operation = crypto.randomUUID(), stamp = new Date().toISOString();
  const result = await c.db().batch([
    receipt(c, u, t, operation, stamp, `Изменил(а) статус: «${names[t.status]}» → «Выполнена». Принял(а) работу`),
    c.q(`INSERT OR IGNORE INTO ledger (id,company_id,user_id,amount,reason,reference,approved_by,created_at)
      SELECT ?||':'||a.user_id,t.company_id,a.user_id,
        CASE WHEN json_extract(c.settings,'$.points') THEN t.points ELSE 0 END,
        'Задача «'||t.title||'»',t.id||':'||a.user_id,?,?
      FROM tasks t JOIN task_assignees a ON a.task_id=t.id JOIN companies c ON c.id=t.company_id
      WHERE t.id=? AND ${guard} AND NOT EXISTS (
        SELECT 1 FROM ledger l WHERE l.company_id=t.company_id AND l.user_id=a.user_id
        AND (l.reference=t.id OR l.reference=t.id||':'||a.user_id))`, operation, u.id, stamp, t.id, operation),
    c.q(`INSERT INTO notifications (id,company_id,user_id,title,task_id,created_at)
      SELECT lower(hex(randomblob(16))),t.company_id,a.user_id,
        'Задача «'||t.title||'» принята. '||CASE WHEN EXISTS (
          SELECT 1 FROM ledger l WHERE l.user_id=a.user_id AND l.id=?||':'||a.user_id
          AND (l.reference=t.id OR l.reference=t.id||':'||a.user_id)
        ) THEN 'Начислено '||CASE WHEN json_extract(c.settings,'$.points') THEN t.points ELSE 0 END||' баллов'
          ELSE 'Ранее начисленные баллы сохранены' END,t.id,?
      FROM tasks t JOIN task_assignees a ON a.task_id=t.id JOIN companies c ON c.id=t.company_id
      WHERE t.id=? AND ${guard}`, operation, stamp, t.id, operation),
    c.q(`UPDATE tasks SET status='done',started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),approved_at=? WHERE id=? AND ${guard}`, stamp, stamp, stamp, t.id, operation),
  ]);
  if (!result[0].meta.changes) c.fail(409, 'Задача изменилась. Обновите карточку');
  return {ok: true};
}

export async function changeTaskStatus(c: TaskContext, u: Row, t: Row, status: unknown) {
  if (typeof status !== 'string' || !Object.hasOwn(names, status)) c.fail(400, 'Выберите корректный статус задачи');
  if (!isManager(u)) {
    if (!t.assignee_ids.includes(u.id)) c.fail(403, 'Статус меняет исполнитель или руководитель');
    if (!((t.status === 'new' && status === 'progress') || (t.status === 'progress' && status === 'review'))) c.fail(409, 'Сотрудник может начать работу и отправить результат на проверку');
  }
  if (status === t.status) return {ok: true};
  if (status === 'done') return completeTask(c, u, t);
  const operation = crypto.randomUUID(), stamp = new Date().toISOString();
  const result = await c.db().batch([
    receipt(c, u, t, operation, stamp, `Изменил(а) статус: «${names[t.status]}» → «${names[status]}»`),
    c.q(`UPDATE tasks SET status=?,started_at=CASE WHEN ?='new' THEN NULL ELSE COALESCE(started_at,?) END,completed_at=CASE WHEN ?='review' THEN ? ELSE NULL END,approved_at=NULL WHERE id=? AND ${guard}`, status, status, stamp, status, stamp, t.id, operation),
    c.q(`INSERT INTO notifications (id,company_id,user_id,title,task_id,created_at)
      SELECT lower(hex(randomblob(16))),t.company_id,u.id,'Задача «'||t.title||'»: '||?,t.id,?
      FROM tasks t JOIN users u ON u.company_id=t.company_id
      WHERE t.id=? AND ${guard} AND u.active=1 AND (
        u.id IN (SELECT user_id FROM task_assignees WHERE task_id=t.id)
        OR (?='review' AND u.role IN ('admin','manager')))`, names[status] + (status === 'review' ? '. Ожидает проверки' : ''), stamp, t.id, operation, status),
  ]);
  if (!result[0].meta.changes) c.fail(409, 'Задача изменилась. Обновите карточку');
  return {ok: true};
}

export async function deleteTask(c: TaskContext, u: Row, t: Row) {
  if (!isManager(u)) c.fail(403, 'Удалять задачи может только руководитель или администратор');
  const operation = crypto.randomUUID(), stamp = new Date().toISOString();
  const result = await c.db().batch([
    receipt(c, u, t, operation, stamp, 'Удалил(а) задачу. История начислений сохранена'),
    c.q(`UPDATE tasks SET deleted_at=? WHERE id=? AND company_id=? AND ${guard}`, stamp, t.id, u.company_id, operation),
    c.q(`DELETE FROM notifications WHERE task_id=? AND company_id=? AND ${guard}`, t.id, u.company_id, operation),
  ]);
  if (!result[0].meta.changes) c.fail(409, 'Задача изменилась. Обновите карточку');
  return {ok: true};
}
