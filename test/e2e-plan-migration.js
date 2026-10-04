/* eslint-disable no-console */
// 端到端验证：航次前进后把未发布试排方案迁移到当前航次修订号
//   - 所见版本过期（方案修订号 / 航次修订号）-> 409 stale_revision，方案不变
//   - 已发布方案 -> 409 plan_published
//   - 以来源修订号正式布局为共同基线逐箱三路合并：仅一方改动取该方；双方同位一致；
//     目标不同 -> 409 migration_conflict（返回箱号与双方位置），方案保持原状
//   - 按当前航次约束复验合并布局：违规 422 不迁移；成功后来源修订号/约束快照原子刷新，
//     方案修订号 +1，旧方案布局仍可追溯；再次迁移以新来源修订号为基线
//   - 迁移不改变正式布局、清单与核对作业；迁移后发布仍遵守现有冲突/重复发布规则
// 运行: node test/e2e-plan-migration.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30198;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-plan-migrate'),
    user: 'stowage',
    password: 'stowage',
    port: 54398,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54398/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const posOf = (layout, boxNo) => layout.placements.find((p) => p.boxNo === boxNo)?.position;

  try {
    // ---- 登记：3x3x2；默认 10000；规则 1-3 距离 3；4 箱 ----
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-MIG-001',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'B1', weight: '500', category: '1' },
        { boxNo: 'B2', weight: '600', category: '3' },
        { boxNo: 'B3', weight: '400', category: '5' },
        { boxNo: 'B4', weight: '300', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    }, 201);
    const vid = voyage.id;

    // 正式布局 rev=1：B1@(1,1,0) B4@(1,1,1) B2@(3,3,0) B3@(2,2,0)
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
        { boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } },
      ],
    }, 200);

    // ---- 从 rev=1 建立四个方案，分别制造不同合并情形 ----
    const planOk = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '合并成功' }, 201)).body;
    const planConflict = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '冲突' }, 201)).body;
    const planViolate = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '复验违规' }, 201)).body;
    const planFresh = (await http('POST', `${BASE}/voyages/${vid}/plans`, { label: '未调整方案' }, 201)).body;

    // 成功候选：B3 -> (3,1,0)，与航次之后的改动同位（双方改到同一位置视为一致）
    await http('POST', `${BASE}/plans/${planOk.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } }],
    }, 200);
    // 冲突候选：B3 -> (3,2,0)（与航次之后的目标 (3,1,0) 不同；|3-1|+|2-3|=3 达标）
    await http('POST', `${BASE}/plans/${planConflict.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 2, tier: 0 } }],
    }, 200);
    // 违规候选：B2 -> (2,3,0)（旧快照下 |2-1|+|3-1|=3 达标；新约束距离 4 时合并后违规）
    await http('POST', `${BASE}/plans/${planViolate.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B2', position: { bay: 2, row: 3, tier: 0 } }],
    }, 200);
    // planFresh 不做任何方案内调整（planRevision=0）

    // ---- 正式航次 rev=1 -> 2（布局调整，约束沿用）：B3 -> (3,1,0) ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } }],
    }, 200);

    // 发布均冲突（前置状态确认）
    const prePub = await http('POST', `${BASE}/plans/${planOk.planId}/publish`, undefined);
    check('迁移前发布冲突 409 publish_conflict',
      prePub.status === 409 && prePub.body.error.code === 'publish_conflict');

    // ---- 1. 所见版本过期：方案修订号 / 航次修订号 ----
    const stalePlan = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: 0, seenVoyageRevision: 2,
    });
    check('所见方案修订号过期 -> 409 stale_revision(scope=plan，返回当前方案修订号 1)',
      stalePlan.status === 409 && stalePlan.body.error.code === 'stale_revision' &&
      stalePlan.body.error.details.scope === 'plan' &&
      stalePlan.body.error.details.currentRevision === 1, JSON.stringify(stalePlan.body));

    const staleVoyage = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: 1, seenVoyageRevision: 1,
    });
    check('所见航次修订号过期 -> 409 stale_revision(scope=voyage，返回当前航次修订号 2)',
      staleVoyage.status === 409 && staleVoyage.body.error.code === 'stale_revision' &&
      staleVoyage.body.error.details.scope === 'voyage' &&
      staleVoyage.body.error.details.currentRevision === 2, JSON.stringify(staleVoyage.body));

    const badRev = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: -1, seenVoyageRevision: 2,
    });
    check('非法修订号 -> 400 invalid_revision',
      badRev.status === 400 && badRev.body.error.code === 'invalid_request_body');

    // 过期拒绝后方案不变
    const okStill = (await http('GET', `${BASE}/plans/${planOk.planId}`, undefined, 200)).body;
    check('过期拒绝后方案不变（来源 1、方案修订号 1）',
      okStill.sourceRevision === 1 && okStill.planRevision === 1);

    // ---- 2. 双方目标不同 -> 409 migration_conflict，方案保持原状 ----
    const conflict = await http('POST', `${BASE}/plans/${planConflict.planId}/migrate`, {
      seenPlanRevision: 1, seenVoyageRevision: 2,
    });
    check('合并冲突 -> 409 migration_conflict',
      conflict.status === 409 && conflict.body.error.code === 'migration_conflict' &&
      conflict.body.error.details.conflictCount === 1, JSON.stringify(conflict.body));
    const c0 = conflict.body.error.details.conflicts[0];
    check('冲突明细：箱号 B3 与双方位置（方案 (3,2,0) / 航次 (3,1,0)）',
      c0.boxNo === 'B3' &&
      c0.planPosition.bay === 3 && c0.planPosition.row === 2 &&
      c0.voyagePosition.bay === 3 && c0.voyagePosition.row === 1, JSON.stringify(c0));
    const conflictKept = (await http('GET', `${BASE}/plans/${planConflict.planId}`, undefined, 200)).body;
    check('冲突后方案保持原状（来源仍 1、修订号仍 1、B3 仍 (3,2,0)）',
      conflictKept.sourceRevision === 1 && conflictKept.planRevision === 1 &&
      posOf(conflictKept, 'B3').row === 2);

    // ---- 3. 正式航次 rev=2 -> 3：约束变更（规则 1-3 距离 3 -> 4），布局继承 ----
    await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 2,
      defaultColumnWeightLimit: '10000',
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 4 }],
    }, 200);

    // ---- 4. 当前约束复验违规 -> 422 validation_failed，不迁移 ----
    const violate = await http('POST', `${BASE}/plans/${planViolate.planId}/migrate`, {
      seenPlanRevision: 1, seenVoyageRevision: 3,
    });
    check('合并布局按当前约束复验违规 -> 422 validation_failed',
      violate.status === 422 && violate.body.error.code === 'validation_failed' &&
      violate.body.error.details.violations.some((x) => x.reason === 'incompatible_too_close'),
      JSON.stringify(violate.body));
    const violateKept = (await http('GET', `${BASE}/plans/${planViolate.planId}`, undefined, 200)).body;
    check('违规不迁移：来源仍 1、方案修订号仍 1、约束快照仍是旧规则距离 3',
      violateKept.sourceRevision === 1 && violateKept.planRevision === 1 &&
      violateKept.incompatRules[0].minDistance === 3 &&
      posOf(violateKept, 'B2').bay === 2);

    // ---- 5. 迁移成功：逐箱合并 + 原子推进来源/快照 + 方案修订号 +1 ----
    const mig = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: 1, seenVoyageRevision: 3,
    }, 200);
    check('迁移成功 200：migrated=true，来源 1->3，方案修订号 1->2',
      mig.body.migrated === true && mig.body.reason === 'migrated' &&
      mig.body.previousSourceRevision === 1 && mig.body.sourceRevision === 3 &&
      mig.body.previousPlanRevision === 1 && mig.body.planRevision === 2 &&
      mig.body.voyageRevision === 3, JSON.stringify(mig.body));
    check('合并布局：B3 双方同位 (3,1,0)；B1/B4/B2 沿用基线',
      posOf(mig.body.plan, 'B3').bay === 3 && posOf(mig.body.plan, 'B3').row === 1 &&
      posOf(mig.body.plan, 'B2').bay === 3 && posOf(mig.body.plan, 'B1').bay === 1);
    check('约束快照已刷新为当前航次（规则距离 4）',
      mig.body.plan.incompatRules[0].minDistance === 4);

    // 正式航次不受迁移影响
    const voyageAfterMig = (await http('GET', `${BASE}/voyages/${vid}`, undefined, 200)).body;
    check('迁移不改变航次修订号（仍为 3）', voyageAfterMig.revision === 3);
    const layoutAfterMig = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('迁移不改变正式布局（B3 仍在 (3,1,0)）',
      posOf(layoutAfterMig, 'B3').bay === 3 && posOf(layoutAfterMig, 'B3').row === 1);

    // ---- 6. 旧方案布局仍可追溯（plan_placements 按方案修订号全量留痕）----
    const hist = await pool.query(
      `SELECT rev, box_no, bay, row, tier FROM plan_placements WHERE plan_id=$1 ORDER BY rev, box_no`,
      [planOk.planId],
    );
    const revRows = hist.rows.filter((r) => Number(r.rev) === 1);
    const rev2Rows = hist.rows.filter((r) => Number(r.rev) === 2);
    const oldB3 = revRows.find((r) => r.box_no === 'B3');
    const newB3 = rev2Rows.find((r) => r.box_no === 'B3');
    check('旧方案修订号 1 的布局仍留痕（B3@(3,1,0)，4 箱）',
      revRows.length === 4 && Number(oldB3.bay) === 3 && Number(oldB3.row) === 1);
    check('新方案修订号 2 保存合并布局（B3@(3,1,0)，4 箱）',
      rev2Rows.length === 4 && Number(newB3.bay) === 3 && Number(newB3.row) === 1);

    // ---- 7. 来源已当前：重复迁移幂等 no-op（migrated=false, already_current）----
    const again = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: 2, seenVoyageRevision: 3,
    }, 200);
    check('再次迁移已是当前 -> migrated=false/already_current，修订号不变',
      again.body.migrated === false && again.body.reason === 'already_current' &&
      again.body.planRevision === 2 && again.body.sourceRevision === 3,
      JSON.stringify(again.body));

    // ---- 8. 迁移后发布成功（航次当前修订号=新来源修订号）----
    const pub = await http('POST', `${BASE}/plans/${planOk.planId}/publish`, undefined, 201);
    check('迁移后发布成功 201：写入航次修订号 4，继承方案（当前航次）约束',
      pub.body.voyageRevision === 4 && pub.body.sourceRevision === 3 &&
      pub.body.planRevision === 2 &&
      pub.body.layout.incompatRules[0].minDistance === 4, JSON.stringify(pub.body));
    check('发布布局=合并布局（B3@(3,1,0)、B2@(3,3,0)）',
      posOf(pub.body.layout, 'B3').row === 1 && posOf(pub.body.layout, 'B2').bay === 3);
    const repub = await http('POST', `${BASE}/plans/${planOk.planId}/publish`, undefined, 200);
    check('迁移后方案重复发布仍幂等 200 replay（修订号 4）',
      repub.body.replay === true && repub.body.voyageRevision === 4);
    const migPublished = await http('POST', `${BASE}/plans/${planOk.planId}/migrate`, {
      seenPlanRevision: 2, seenVoyageRevision: 4,
    });
    check('已发布方案迁移 -> 409 plan_published',
      migPublished.status === 409 && migPublished.body.error.code === 'plan_published');

    // 清单与核对作业以迁移发布产生的 rev=4 为基准（后续航次前进/迁移不改变其冻结基准）
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 4 }, 201);
    const job = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 4 }, 201);
    check('以迁移发布产生的 rev=4 清单开启核对作业', job.body.job.manifestRevision === 4);
    const b2Expected = job.body.expected.find((e) => e.boxNo === 'B2');
    check('核对作业基准为冻结清单（B2@(3,3,0)）',
      b2Expected.position.bay === 3 && b2Expected.position.row === 3,
      JSON.stringify(b2Expected));
    const jobId = job.body.job.jobId;

    // ---- 9. 再次迁移以新来源修订号为基线（航次 4 -> 5 后迁未调整方案 fresh）----
    // fresh 仍以 rev=1 为来源、planRevision=0、布局=rev=1。先验证跨多修订号迁移。
    // B3 (2,1,0)->(2,2,0)（B3 为 5 类无不相容约束；列 (2,2) 单箱）
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 4,
      moves: [{ boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } }],
    }, 200);
    const migFresh = await http('POST', `${BASE}/plans/${planFresh.planId}/migrate`, {
      seenPlanRevision: 0, seenVoyageRevision: 5,
    }, 200);
    check('跨多修订号迁移成功：来源 1->5，方案修订号 0->1',
      migFresh.body.migrated === true && migFresh.body.previousSourceRevision === 1 &&
      migFresh.body.sourceRevision === 5 && migFresh.body.planRevision === 1,
      JSON.stringify(migFresh.body));
    check('合并采用航次当前布局（方案侧未改动；B2@(3,3,0)）',
      posOf(migFresh.body.plan, 'B2').bay === 3 && posOf(migFresh.body.plan, 'B2').row === 3 &&
      posOf(migFresh.body.plan, 'B3').bay === 2 && posOf(migFresh.body.plan, 'B3').row === 2);

    // ---- 10. 第二次迁移：来源 5 的正式布局为共同基线 ----
    // 在 fresh 上调整 B4 撤位（当前 5 箱位：B1@(1,1,0),B4@(1,1,1)；撤 B4 后 B1 在底层连续）
    await http('POST', `${BASE}/plans/${planFresh.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B4', position: null }],
    }, 200);
    // 航次 5 -> 6：B3 撤位（B3 独占 (2,2,0)）
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 5,
      moves: [{ boxNo: 'B3', position: null }],
    }, 200);
    const mig2 = await http('POST', `${BASE}/plans/${planFresh.planId}/migrate`, {
      seenPlanRevision: 2, seenVoyageRevision: 6,
    }, 200);
    check('第二次迁移：来源 5->6，方案修订号 2->3',
      mig2.body.migrated === true && mig2.body.previousSourceRevision === 5 &&
      mig2.body.sourceRevision === 6 && mig2.body.previousPlanRevision === 2 &&
      mig2.body.planRevision === 3, JSON.stringify(mig2.body));
    check('再次合并：方案撤 B4 + 航次撤 B3 各自采用（双方改动箱不相交）',
      !posOf(mig2.body.plan, 'B4') && !posOf(mig2.body.plan, 'B3') &&
      posOf(mig2.body.plan, 'B1').bay === 1 && posOf(mig2.body.plan, 'B2').row === 3 &&
      mig2.body.plan.unplacedBoxNos.sort().join(',') === 'B3,B4');

    // ---- 11. 迁移不触碰清单与核对作业：航次继续前进与多次迁移后，既有作业基准仍冻结 ----
    const jobAfter = (await http('GET', `${BASE}/check-jobs/${jobId}`, undefined, 200)).body;
    const b2After = jobAfter.details.expected.find((e) => e.boxNo === 'B2');
    check('既有核对作业基准仍冻结在 rev=4 清单（B2@(3,3,0)）',
      b2After.position.bay === 3 && b2After.position.row === 3, JSON.stringify(b2After));

    // 未知方案迁移 -> 404
    const nf = await http('POST', `${BASE}/plans/00000000-0000-0000-0000-000000000000/migrate`, {
      seenPlanRevision: 0, seenVoyageRevision: 1,
    });
    check('未知方案迁移 -> 404 plan_not_found',
      nf.status === 404 && nf.body.error.code === 'plan_not_found');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
