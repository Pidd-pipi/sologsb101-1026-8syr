<script setup lang="ts">
/** 倒罐派工表单：源罐 / 目标罐 / 倒出量 / 清空要求 / 期望时段，提交后由 store 派工 */
import { reactive, ref, watch, computed } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import type { TankRow } from '@/utils/db'
import { createEmptyJobForm, type PumpJobForm } from '@/types/pump'

const props = defineProps<{
  tanks: TankRow[]
  device: string
  /** 在线派工 或 断网暂存（平板断网演示开关） */
  mode: '在线' | '断网'
}>()

const emit = defineEmits<{
  (e: 'submit', form: PumpJobForm, mode: '在线' | '断网'): void
}>()

const formRef = ref<FormInstance>()
const form = reactive<PumpJobForm>({ ...createEmptyJobForm(), device: props.device })

watch(
  () => props.device,
  (next) => {
    form.device = next
  }
)

const tankOptions = computed(() =>
  props.tanks
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    .map((tank) => ({
      id: tank.id,
      label: `${tank.code} · ${tank.capacityL}L · ${tank.state}`
    }))
)

/** 选择源罐时，倒出量默认带出源罐当前液位（页面把液位通过 map 传进来） */
const levelMap = defineModel<Record<string, number>>('levels', { required: true })

watch(
  () => form.sourceTankId,
  (id) => {
    if (id && form.requireEmpty && typeof levelMap.value[id] === 'number') {
      form.volumeL = levelMap.value[id]
    }
  }
)

watch(
  () => form.requireEmpty,
  (empty) => {
    if (empty && form.sourceTankId && typeof levelMap.value[form.sourceTankId] === 'number') {
      form.volumeL = levelMap.value[form.sourceTankId]
    }
  }
)

const rules: FormRules = {
  sourceTankId: [{ required: true, message: '请选择源罐', trigger: 'change' }],
  targetTankId: [{ required: true, message: '请选择目标罐', trigger: 'change' }],
  requestedStartAt: [{ required: true, message: '请选择期望开始时间', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (form.sourceTankId === form.targetTankId) {
    formRef.value?.validateField('targetTankId').catch(() => undefined)
    return
  }
  emit('submit', { ...form, requestedStartAt: new Date(form.requestedStartAt).toISOString() }, props.mode)
}

function reset(): void {
  Object.assign(form, createEmptyJobForm(), { device: props.device })
  formRef.value?.clearValidate()
}

defineExpose({ reset })
</script>

<template>
  <el-form ref="formRef" :model="form" :rules="rules" label-width="96px" class="dispatch-form">
    <el-form-item label="源罐" prop="sourceTankId">
      <el-select v-model="form.sourceTankId" class="full" placeholder="选择倒出罐" filterable>
        <el-option v-for="opt in tankOptions" :key="opt.id" :label="opt.label" :value="opt.id" />
      </el-select>
    </el-form-item>
    <el-form-item label="目标罐" prop="targetTankId">
      <el-select v-model="form.targetTankId" class="full" placeholder="选择接入罐" filterable>
        <el-option
          v-for="opt in tankOptions.filter((opt) => opt.id !== form.sourceTankId)"
          :key="opt.id"
          :label="opt.label"
          :value="opt.id"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="倒出量(L)">
      <el-input-number v-model="form.volumeL" :min="1" :max="50000" :step="50" />
      <el-checkbox v-model="form.requireEmpty" class="empty-check">要求源罐清空</el-checkbox>
    </el-form-item>
    <el-form-item label="期望开始" prop="requestedStartAt">
      <el-date-picker
        v-model="form.requestedStartAt"
        type="datetime"
        format="YYYY-MM-DD HH:mm"
        value-format="YYYY-MM-DDTHH:mm:ss.000Z"
        placeholder="选择期望开始时间"
        class="full"
      />
    </el-form-item>
    <el-form-item label="时长(分钟)">
      <el-input-number v-model="form.durationMin" :min="10" :max="600" :step="10" />
    </el-form-item>
    <el-form-item label="操作人" prop="operator">
      <el-input v-model="form.operator" placeholder="如：陈岩" />
    </el-form-item>
    <el-form-item>
      <el-button type="primary" @click="submit">
        {{ mode === '断网' ? '断网暂存（稍后合并）' : '提交派工' }}
      </el-button>
      <el-button @click="reset">清空</el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped>
.full {
  width: 100%;
}

.empty-check {
  margin-left: 12px;
}
</style>
