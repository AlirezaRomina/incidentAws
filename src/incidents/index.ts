import type { Incident } from '../engine/types';
import diskFull from './disk-full';
import albSecurityGroup from './alb-security-group';
import dnsStaleCname from './dns-stale-cname';
import checkoutSlowQuery from './checkout-slow-query';
import rdsBurstBalance from './rds-burst-balance';
import dnsResolverThrottling from './dns-resolver-throttling';

export const INCIDENTS: Incident[] = [diskFull, albSecurityGroup, dnsStaleCname, checkoutSlowQuery, rdsBurstBalance, dnsResolverThrottling].sort((a, b) => a.order - b.order);

export const incidentById = (id: string) => INCIDENTS.find(i => i.id === id);
