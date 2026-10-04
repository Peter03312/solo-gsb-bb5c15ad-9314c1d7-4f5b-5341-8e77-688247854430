#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 试排方案迁移 curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/plan-migration-curl.sh
#
# 演示：登记 -> 正式配位 -> 建立试排方案并调整 -> 正式航次前进（布局+约束）->
#       发布冲突 409 -> 迁移：所见版本过期 409 / 合并冲突 409（方案保留）/
#       复验违规 422（不迁移）/ 成功迁移 200（来源与约束快照原子推进、方案修订号+1）->
#       迁移后发布 201 -> 再次迁移 already_current -> 正式布局/清单/核对不受迁移影响。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jqid() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-MIG-$(date +%s)（3x3x2，默认承重 10000，类别 1-3 距离 3）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-MIG-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" },
    { "boxNo": "B4", "weight": "300", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | jqid id)
echo "voyageId=$VID"

say "2) 正式配位（航次 revision 0 -> 1）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B4", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}' >/dev/null
echo "航次当前修订号=1"

say "3) 建立两个试排方案：方案OK（B3 -> (3,1,0)）/ 方案冲突（B3 -> (3,2,0)）"
PLAN_OK_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "迁移成功候选" }')
PO=$(echo "$PLAN_OK_JSON" | jqid planId)
curl -sS -X POST "$API/plans/$PO/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [ { "boxNo": "B3", "position": { "bay": 3, "row": 1, "tier": 0 } } ]
}' >/dev/null
echo "方案OK 已调整（planId=$PO，方案修订号=1）"

PLAN_CF_JSON=$(curl -sS -X POST "$API/voyages/$VID/plans" -H 'content-type: application/json' -d '{ "label": "合并冲突候选" }')
PC=$(echo "$PLAN_CF_JSON" | jqid planId)
curl -sS -X POST "$API/plans/$PC/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [ { "boxNo": "B3", "position": { "bay": 3, "row": 2, "tier": 0 } } ]
}' >/dev/null
echo "冲突候选已调整（planId=$PC，方案修订号=1）"

say "4) 正式航次前进（布局调整 1 -> 2）：B3 -> (3,1,0)"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [ { "boxNo": "B3", "position": { "bay": 3, "row": 1, "tier": 0 } } ]
}' >/dev/null
echo "航次当前修订号=2"

say "5) 此时发布 -> 409 publish_conflict（航次 2 ≠ 来源 1），方案保留"
curl -sS -X POST "$API/plans/$PO/publish"; echo

say "6) 迁移：所见方案修订号过期 -> 409 stale_revision（scope=plan）"
curl -sS -X POST "$API/plans/$PO/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 0, "seenVoyageRevision": 2
}'; echo

say "7) 迁移：所见航次修订号过期 -> 409 stale_revision（scope=voyage）"
curl -sS -X POST "$API/plans/$PO/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 1, "seenVoyageRevision": 1
}'; echo

say "8) 正式航次继续前进（约束变更 2 -> 3）：类别 1-3 最小距离 3 -> 4，布局继承"
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 2,
  "defaultColumnWeightLimit": "10000",
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 4 }
  ]
}' >/dev/null
echo "航次当前修订号=3"

say "9) 合并冲突：双方对 B3 的目标不同 -> 409 migration_conflict（返回箱号与双方位置，方案保持原状）"
curl -sS -X POST "$API/plans/$PC/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 1, "seenVoyageRevision": 3
}'; echo

say "10) 成功迁移：以来源修订号 1 的正式布局为共同基线逐箱合并 -> 200"
echo "    方案来源修订号 1->3、约束快照刷新为当前航次、方案修订号 1->2，航次修订号不变"
curl -sS -X POST "$API/plans/$PO/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 1, "seenVoyageRevision": 3
}'; echo

say "11) 再次迁移：来源已等于当前修订号 -> 200 migrated=false / already_current（不产生新方案修订号）"
curl -sS -X POST "$API/plans/$PO/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 2, "seenVoyageRevision": 3
}'; echo

say "12) 迁移后发布成功 -> 201（航次修订号 3 -> 4，继承方案当前约束；旧方案布局按方案修订号留痕）"
curl -sS -X POST "$API/plans/$PO/publish"; echo

say "13) 已发布方案迁移 -> 409 plan_published"
curl -sS -X POST "$API/plans/$PO/migrate" -H 'content-type: application/json' -d '{
  "seenPlanRevision": 2, "seenVoyageRevision": 4
}'; echo

say "14) 正式布局与迁移无关：航次当前修订号=4，历史布局 rev=1/2/3 均可追溯"
curl -sS "$API/voyages/$VID/layout" | head -c 400; echo
curl -sS "$API/voyages/$VID/layout?rev=1" | head -c 400; echo
