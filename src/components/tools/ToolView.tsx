import type { Environment, Incident, ToolId } from '../../engine/types';
import { Briefing } from './Briefing';
import { CloudWatch } from './CloudWatch';
import { Logs } from './Logs';
import { Ec2 } from './Ec2';
import { LoadBalancers } from './LoadBalancers';
import { Rds } from './Rds';
import { Route53View, VpcView } from './Network';
import { CloudTrailView, DeploysView, IamView } from './Security';
import { Terminal } from './Terminal';

export interface ToolProps {
  env: Environment;
  incident: Incident;
  onNavigate: (t: ToolId) => void;
}

export function ToolView({ tool, ...p }: ToolProps & { tool: ToolId }) {
  switch (tool) {
    case 'briefing':
      return <Briefing {...p} />;
    case 'cloudwatch':
      return <CloudWatch {...p} />;
    case 'logs':
      return <Logs {...p} />;
    case 'ec2':
      return <Ec2 {...p} />;
    case 'alb':
      return <LoadBalancers {...p} />;
    case 'rds':
      return <Rds {...p} />;
    case 'vpc':
      return <VpcView {...p} />;
    case 'route53':
      return <Route53View {...p} />;
    case 'iam':
      return <IamView {...p} />;
    case 'cloudtrail':
      return <CloudTrailView {...p} />;
    case 'deploys':
      return <DeploysView {...p} />;
    case 'terminal':
      return <Terminal {...p} />;
  }
}

export function ToolHeader({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="tool-h">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}
