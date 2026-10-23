import type { Incident } from '../engine/types';
import diskFull from './disk-full';
import albSecurityGroup from './alb-security-group';
import dnsStaleCname from './dns-stale-cname';
import checkoutSlowQuery from './checkout-slow-query';
import oomMemoryLeak from './oom-memory-leak';
import iamS3AccessDenied from './iam-s3-access-denied';
import dbConnectionExhaustion from './db-connection-exhaustion';
import natGatewayDeleted from './nat-gateway-deleted';
import replicaLagStaleReads from './replica-lag-stale-reads';
import ephemeralPortExhaustion from './ephemeral-port-exhaustion';
import rdsBurstBalance from './rds-burst-balance';
import dnsResolverThrottling from './dns-resolver-throttling';

export const INCIDENTS: Incident[] = [diskFull, albSecurityGroup, dnsStaleCname, checkoutSlowQuery, oomMemoryLeak, iamS3AccessDenied, dbConnectionExhaustion, natGatewayDeleted, replicaLagStaleReads, ephemeralPortExhaustion, rdsBurstBalance, dnsResolverThrottling].sort((a, b) => a.order - b.order);

export const incidentById = (id: string) => INCIDENTS.find(i => i.id === id);
