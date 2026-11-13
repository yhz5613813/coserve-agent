import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from './storage.js';

export const CADFLOW_PLUGIN_ID = 'zion-zion-zion-cadflow-skill';
export const CADFLOW_SKILL_DIR = fileURLToPath(new URL('../resources/cadflow/', import.meta.url));
const optimizationSkillDir = fileURLToPath(new URL('../resources/heatsink-optimization/', import.meta.url));
export async function builtInSkillPaths() {
  await fs.access(path.join(CADFLOW_SKILL_DIR, 'SKILL.md'));
  return [CADFLOW_SKILL_DIR, fileURLToPath(new URL('../resources/thermal-sim/', import.meta.url)), fileURLToPath(new URL('../resources/structural-sim/', import.meta.url)), optimizationSkillDir];
}

/** Load the packaged guidance before a proposal claim is committed; the full content is logged in the design child's prompt. */
export async function loadOptimizationSkill() {
  let content: string;
  try { content = await fs.readFile(path.join(optimizationSkillDir, 'SKILL.md'), 'utf8'); }
  catch (error) { throw new HttpError(503, `内置散热器优化 Skill 无法读取：${(error as Error).message}`); }
  if (!content.trim()) throw new HttpError(503, '内置散热器优化 Skill 内容为空，请恢复安装文件');
  return { name: 'heatsink-optimization', sha256: createHash('sha256').update(content).digest('hex'), content };
}
