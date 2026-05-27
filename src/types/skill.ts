export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt: string;
  tags: string[];
  author: string;
  version: string;
}

export interface ImportedSkill {
  id: string;
  sourceTemplateId: string | null;
  sourceVersion: string | null;
  name: string;
  description: string;
  category: string;
  prompt: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
