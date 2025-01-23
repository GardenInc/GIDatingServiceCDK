import { SERVICE_STACK, VPC_STACK } from './constants';

export function createServiceStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${SERVICE_STACK}`;
}

export function createVpcStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${VPC_STACK}`;
}
