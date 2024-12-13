import { SERVICE_STACK } from './constants';

export function createServiceStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${SERVICE_STACK}`;
}
