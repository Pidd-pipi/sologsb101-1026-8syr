<script setup lang="ts">
/** 发酵罐液体账：每个罐的当前液位（流水求和）、空余容量与占用条 */
import type { TankLevel } from '@/hooks/usePumpBoard'

defineProps<{
  levels: TankLevel[]
}>()
</script>

<template>
  <div class="liquid-grid">
    <div v-for="item in levels" :key="item.tank.id" class="liquid-card">
      <div class="liquid-card__head">
        <strong>{{ item.tank.code }}</strong>
        <el-tag size="small" :type="item.tank.state === '清洗中' ? 'warning' : item.tank.state === '在用' ? 'success' : 'info'" effect="plain">
          {{ item.tank.state }}
        </el-tag>
      </div>
      <el-progress
        :percentage="Math.max(0, Math.min(100, item.usageRatio))"
        :status="item.freeL < 0 ? 'exception' : item.usageRatio > 90 ? 'warning' : undefined"
        :stroke-width="14"
      />
      <div class="liquid-card__nums">
        <span>现存 {{ item.levelL }}L</span>
        <span :class="{ over: item.freeL < 0 }">空余 {{ item.freeL }}L</span>
        <span class="muted">罐容 {{ item.tank.capacityL }}L</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.liquid-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.liquid-card {
  padding: 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
}

.liquid-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.liquid-card__nums {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.liquid-card__nums .over {
  color: #c0392b;
  font-weight: 700;
}

.muted {
  color: #8c8479;
}
</style>
