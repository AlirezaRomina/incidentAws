import type { Difficulty, ToolId } from '../../engine/types';
import type { IconName } from './Icon';

export const DIFFICULTY: Record<Difficulty, { label: string; cls: string; blurb: string }> = {
  beginner: { label: 'Beginner', cls: 'ok', blurb: 'One clear failure. Learn the tools and the habit of checking each layer.' },
  intermediate: { label: 'Intermediate', cls: 'info', blurb: 'The symptom is far from the cause. Correlate metrics, logs and recent changes.' },
  advanced: { label: 'Advanced', cls: 'violet', blurb: 'Misleading signals and multi-layer failures. Prove it, don\u2019t guess.' },
  expert: { label: 'Expert', cls: 'crit', blurb: 'Subtle platform limits. The obvious metrics look fine.' },
};

export const TOOLS: { id: ToolId; label: string; icon: IconName; group: string }[] = [
  { id: 'briefing', label: 'Briefing', icon: 'pager', group: 'Incident' },
  { id: 'cloudwatch', label: 'CloudWatch', icon: 'chart', group: 'Observe' },
  { id: 'logs', label: 'Logs', icon: 'logs', group: 'Observe' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', group: 'Observe' },
  { id: 'ec2', label: 'EC2', icon: 'server', group: 'Infrastructure' },
  { id: 'alb', label: 'Load Balancers', icon: 'balance', group: 'Infrastructure' },
  { id: 'rds', label: 'RDS', icon: 'database', group: 'Infrastructure' },
  { id: 'vpc', label: 'VPC', icon: 'route', group: 'Infrastructure' },
  { id: 'route53', label: 'Route 53', icon: 'globe', group: 'Infrastructure' },
  { id: 'iam', label: 'IAM', icon: 'shield', group: 'Security & change' },
  { id: 'cloudtrail', label: 'CloudTrail', icon: 'trail', group: 'Security & change' },
  { id: 'deploys', label: 'Deploys & Changes', icon: 'git', group: 'Security & change' },
];
