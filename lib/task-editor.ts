type Row = Record<string, any>;
type Context = {
  q: (sql: string, ...args: any[]) => D1PreparedStatement;
  all: (sql: string, ...args: any[]) => Promise<Row[]>;
  db: () => D1Database;
  fail: (status: number, message: string) => never;
  str: (value: any, name: string, max?: number) => string;
  num: (value: any, name: string, min?: number, max?: number) => number;
  note: (company: string, user: string, title: string, task?: string | null) => D1PreparedStatement;
};

export async function saveTask(c: Context, user: Row, body: Row, existing?: Row) {
  if (!['admin', 'manager'].includes(user.role)) c.fail(403, 'Доступно только руководителю');
  const raw = body.assignee_ids ?? (body.assignee_id ? [body.assignee_id] : existing?.assignee_ids);
  if (!Array.isArray(raw) || !raw.length || raw.length > 100 || raw.some(v => typeof v !== 'string')) c.fail(400, 'Выберите от 1 до 100 исполнителей');
  const ids: string[] = [...new Set<string>(raw)];
  const people = await c.all(`SELECT id,name,active,role FROM users WHERE company_id=? AND id IN (${ids.map(() => '?').join(',')})`, user.company_id, ...ids);
  if (people.length !== ids.length || people.some(p => (!p.active || p.role !== 'employee') && !existing?.assignee_ids.includes(p.id))) c.fail(400, 'Можно назначать только активных сотрудников своей компании');
  const deadline = new Date(body.deadline ?? existing?.deadline);
  if (!Number.isFinite(deadline.getTime())) c.fail(400, 'Укажите корректный срок');
  if ((!existing || deadline.toISOString() !== existing.deadline) && deadline.getTime() <= Date.now()) c.fail(400, 'Новый срок должен быть в будущем');
  const title = c.str(body.title ?? existing?.title, 'Название', 200);
  const description = c.str(body.description ?? existing?.description, 'Описание', 10000);
  const priority = body.priority ?? existing?.priority ?? 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) c.fail(400, 'Некорректный приоритет');
  const points = c.num(body.points ?? existing?.points, 'Баллы', 0);
  const id = existing?.id ?? crypto.randomUUID(), time = new Date().toISOString();
  const reassigned = existing && (ids.length !== existing.assignee_ids.length || ids.some(uid => !existing.assignee_ids.includes(uid)));
  const reopened = reassigned && ['review','done'].includes(existing.status);
  const status = reopened ? 'progress' : existing?.status ?? 'new';
  const operation=crypto.randomUUID();
  const audit = existing ? `Изменил(а) задачу: название, описание, срок, приоритет — ${priority}, баллы — ${points}; исполнители: ${people.map(p => p.name).join(', ')}${reopened?'. Задача возвращена в работу':''}` : 'Создал(а) задачу';
  const guard = existing ? 'EXISTS (SELECT 1 FROM activity WHERE id=?)' : 'EXISTS (SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL)';
  const guardId = existing ? operation : id;
  const statements = existing ? [
    c.q('INSERT INTO activity (id,task_id,user_id,body,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND company_id=? AND status=? AND deleted_at IS NULL)',operation,id,user.id,audit,time,id,user.company_id,existing.status),
    c.q(`UPDATE tasks SET title=?,description=?,assignee_id=?,deadline=?,priority=?,points=?,status=?,completed_at=CASE WHEN ? THEN NULL ELSE completed_at END,approved_at=CASE WHEN ? THEN NULL ELSE approved_at END WHERE id=? AND company_id=? AND ${guard}`,title,description,ids[0],deadline.toISOString(),priority,points,status,reopened?1:0,reopened?1:0,id,user.company_id,guardId),
  ] : [c.q('INSERT INTO tasks (id,company_id,title,description,assignee_id,author_id,deadline,priority,points,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, user.company_id, title, description, ids[0], user.id, deadline.toISOString(), priority, points, time)];
  if (existing) statements.push(c.q(`DELETE FROM task_assignees WHERE task_id=? AND ${guard}`, id, guardId));
  for (const uid of ids) statements.push(c.q(`INSERT OR IGNORE INTO task_assignees (task_id,user_id) SELECT ?,? WHERE ${guard}`, id, uid, guardId));
  if (!existing) statements.push(c.q(`INSERT INTO activity (id,task_id,user_id,body,created_at) SELECT ?,?,?,?,? WHERE ${guard}`, operation, id, user.id, audit, time, guardId));
  for (const uid of ids) statements.push(c.q(`INSERT INTO notifications (id,company_id,user_id,title,task_id,created_at) SELECT ?,?,?,?,?,? WHERE ${guard}`, crypto.randomUUID(), user.company_id, uid, `${existing ? 'Обновлена' : 'Новая'} задача «${title}»${reopened?'. Состав исполнителей изменён — задача снова в работе':''}`, id, time, guardId));
  const result = await c.db().batch(statements);
  if (existing && !result[0].meta.changes) c.fail(409, 'Задача изменилась или удалена. Обновите карточку');
  return { id };
}
