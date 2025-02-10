import { SERVICE_STACK, VPC_STACK, DEVICE_FARM_STACK } from './constants';

export function createServiceStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${SERVICE_STACK}`;
}

export function createVpcStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${VPC_STACK}`;
}

export function createDeviceFarmStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${DEVICE_FARM_STACK}`;
}
