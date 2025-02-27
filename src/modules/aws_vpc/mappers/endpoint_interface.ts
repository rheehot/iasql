import {
  CreateVpcEndpointCommandInput,
  EC2,
  ModifyVpcEndpointCommandInput,
  Tag,
  VpcEndpoint as AwsVpcEndpoint,
  DnsRecordIpType,
  Subnet as SubnetAWS,
  DescribeVpcEndpointsCommandInput,
} from '@aws-sdk/client-ec2';
import { createWaiter, WaiterState } from '@aws-sdk/util-waiter';

import { AwsVpcModule } from '..';
import { policiesAreSame } from '../../../services/aws-diff';
import { AWS, crudBuilderFormat } from '../../../services/aws_macros';
import { safeParse } from '../../../services/common';
import { Context, Crud2, MapperBase } from '../../interfaces';
import { Subnet } from '../entity';
import { EndpointInterface, EndpointInterfaceService } from '../entity/endpoint_interface';
import {
  createVpcEndpoint,
  deleteVpcEndpoint,
  getInterfaceServiceFromServiceName,
  getVpcEndpoint,
  getVpcEndpointInterfaces,
  getVpcEndpointInterfaceServiceName,
  modifyVpcEndpoint,
} from './endpoint_helpers';
import { eqTags, updateTags } from './tags';

export class EndpointInterfaceMapper extends MapperBase<EndpointInterface> {
  module: AwsVpcModule;
  entity = EndpointInterface;
  equals = (a: EndpointInterface, b: EndpointInterface) =>
    Object.is(a.dnsNameRecordType, b.dnsNameRecordType) &&
    policiesAreSame(a.policy, b.policy) &&
    Object.is(a.state, b.state) &&
    Object.is(a.vpc?.vpcId, b.vpc?.vpcId) &&
    Object.is(a.subnets.length, b.subnets.length) &&
    !!a.subnets?.every(sa => !!b.subnets?.find(sb => Object.is(sa.id, sb.id))) &&
    eqTags(a.tags, b.tags) &&
    Object.is(a.privateDnsEnabled, b.privateDnsEnabled);

  getVpcSubnets = crudBuilderFormat<EC2, 'describeSubnets', SubnetAWS[] | undefined>(
    'describeSubnets',
    vpcId => ({
      Filters: [
        {
          Name: 'vpc-id',
          Values: [vpcId],
        },
      ],
    }),
    res => res?.Subnets,
  );

  async waitForEndpointAvailable(client: EC2, endpointId: string) {
    return createWaiter<EC2, DescribeVpcEndpointsCommandInput>(
      {
        client,
        // 10 min waiter
        maxWaitTime: 600,
        minDelay: 1,
        maxDelay: 4,
      },
      {
        VpcEndpointIds: [endpointId],
      },
      async (cl, input) => {
        try {
          const data = await cl.describeVpcEndpoints(input);
          if (!data.VpcEndpoints?.length || data.VpcEndpoints[0].State !== 'available') {
            return { state: WaiterState.RETRY };
          }
          return { state: WaiterState.SUCCESS };
        } catch (e: any) {
          throw e;
        }
      },
    );
  }

  async waitForEndpointDeleted(client: EC2, endpointId: string) {
    return createWaiter<EC2, DescribeVpcEndpointsCommandInput>(
      {
        client,
        // 10 min waiter
        maxWaitTime: 600,
        minDelay: 1,
        maxDelay: 4,
      },
      {
        VpcEndpointIds: [endpointId],
      },
      async (cl, input) => {
        try {
          const data = await cl.describeVpcEndpoints(input);
          if (!data.VpcEndpoints?.length) {
            return { state: WaiterState.SUCCESS };
          }
          return { state: WaiterState.RETRY };
        } catch (e: any) {
          throw e;
        }
      },
    );
  }

  async endpointInterfaceMapper(eg: AwsVpcEndpoint, region: string, ctx: Context) {
    if (!eg.ServiceName) return undefined;
    const out = new EndpointInterface();
    out.vpcEndpointId = eg.VpcEndpointId;
    if (!out.vpcEndpointId) return undefined;
    const service = getInterfaceServiceFromServiceName(eg.ServiceName);
    if (!service) return undefined;
    out.service = service as unknown as EndpointInterfaceService;
    out.vpc =
      (await this.module.vpc.db.read(ctx, this.module.vpc.generateId({ vpcId: eg.VpcId ?? '', region }))) ??
      (await this.module.vpc.cloud.read(ctx, this.module.vpc.generateId({ vpcId: eg.VpcId ?? '', region })));
    if (!out.vpc) return undefined;
    out.policy = eg.PolicyDocument ? safeParse(eg.PolicyDocument) : null;
    out.state = eg.State;
    out.dnsNameRecordType = eg.DnsOptions?.DnsRecordIpType as DnsRecordIpType;
    out.privateDnsEnabled = eg.PrivateDnsEnabled ?? false;

    // associate subnets
    out.subnets = [];
    if (eg.SubnetIds) {
      for (const subnet of eg.SubnetIds) {
        // find the subnet
        const s: Subnet =
          (await this.module.subnet.db.read(
            ctx,
            this.module.subnet.generateId({ subnetId: subnet ?? '', region }),
          )) ??
          (await this.module.subnet.cloud.read(
            ctx,
            this.module.subnet.generateId({ subnetId: subnet ?? '', region }),
          ));
        if (s && s.state === 'available') out.subnets.push(s);
      }
    }
    if (eg.Tags?.length) {
      const tags: { [key: string]: string } = {};
      eg.Tags.filter((t: any) => !!t.Key && !!t.Value).forEach((t: any) => {
        tags[t.Key as string] = t.Value as string;
      });
      out.tags = tags;
    }
    out.region = region;
    return out;
  }

  cloud: Crud2<EndpointInterface> = new Crud2({
    create: async (es: EndpointInterface[], ctx: Context) => {
      const out = [];
      for (const e of es) {
        const client = (await ctx.getAwsClient(e.region)) as AWS;
        const serviceName = await getVpcEndpointInterfaceServiceName(client.ec2client, e.service);
        if (!serviceName) continue; // we cannot create without valid service name

        const input: CreateVpcEndpointCommandInput = {
          VpcEndpointType: 'Interface',
          ServiceName: serviceName,
          VpcId: e.vpc?.vpcId,
          PrivateDnsEnabled: e.privateDnsEnabled,
          DnsOptions: { DnsRecordIpType: e.dnsNameRecordType },
        };
        if (e.policy) {
          input.PolicyDocument = JSON.stringify(e.policy);
        }
        if (e.subnets.length) {
          const subnets = [];
          for (const subnet of e.subnets) {
            if (subnet.subnetId) subnets.push(subnet.subnetId);
          }
          input.SubnetIds = subnets ?? [];
        } else {
          // get all subnets for that vpc
          const subnets = await this.getVpcSubnets(client.ec2client, e.vpc?.vpcId ?? '');
          input.SubnetIds = subnets?.map(s => s.SubnetId ?? '')?.filter(id => !!id) ?? [];
        }
        if (e.tags && Object.keys(e.tags).length) {
          const tags: Tag[] = Object.keys(e.tags).map((k: string) => {
            return {
              Key: k,
              Value: e.tags![k],
            };
          });
          input.TagSpecifications = [
            {
              ResourceType: 'vpc-endpoint',
              Tags: tags,
            },
          ];
        }

        const res = await createVpcEndpoint(client.ec2client, input);
        const result = await this.waitForEndpointAvailable(client.ec2client, res?.VpcEndpointId ?? '');
        if (result.state === WaiterState.SUCCESS) {
          const rawEndpointInterface = await getVpcEndpoint(client.ec2client, res?.VpcEndpointId ?? '');
          if (!rawEndpointInterface) continue;
          const newEndpointInterface = await this.endpointInterfaceMapper(
            rawEndpointInterface,
            e.region,
            ctx,
          );
          if (!newEndpointInterface) continue;
          newEndpointInterface.id = e.id;
          await this.module.endpointInterface.db.update(newEndpointInterface, ctx);
          out.push(newEndpointInterface);
        }
      }
      return out;
    },
    read: async (ctx: Context, id?: string) => {
      if (!!id) {
        const { vpcEndpointId, region } = this.idFields(id);
        const client = (await ctx.getAwsClient(region)) as AWS;
        const rawEndpointInterface = await getVpcEndpoint(client.ec2client, vpcEndpointId);
        if (!rawEndpointInterface) return;
        return await this.endpointInterfaceMapper(rawEndpointInterface, region, ctx);
      } else {
        const out: EndpointInterface[] = [];
        const enabledRegions = (await ctx.getEnabledAwsRegions()) as string[];
        await Promise.all(
          enabledRegions.map(async region => {
            const client = (await ctx.getAwsClient(region)) as AWS;
            for (const eg of await getVpcEndpointInterfaces(client.ec2client)) {
              const outEg = await this.endpointInterfaceMapper(eg, region, ctx);
              if (outEg) out.push(outEg);
            }
          }),
        );
        return out;
      }
    },
    updateOrReplace: (a: EndpointInterface, b: EndpointInterface) => {
      if (!(Object.is(a.vpc?.vpcId, b.vpc?.vpcId) && Object.is(a.service, b.service))) return 'replace';
      return 'update';
    },
    update: async (es: EndpointInterface[], ctx: Context) => {
      const out = [];
      for (const e of es) {
        const client = (await ctx.getAwsClient(e.region)) as AWS;
        const cloudRecord = ctx?.memo?.cloud?.EndpointInterface?.[this.entityId(e)];
        const isUpdate = this.module.endpointInterface.cloud.updateOrReplace(cloudRecord, e) === 'update';
        if (isUpdate) {
          let update = false;
          if (!policiesAreSame(cloudRecord.policy, e.policy)) {
            // VPC endpoint policy document update
            const input: ModifyVpcEndpointCommandInput = {
              VpcEndpointId: e.vpcEndpointId,
              PolicyDocument: JSON.stringify(e.policy),
              ResetPolicy: !e.policy,
            };
            await modifyVpcEndpoint(client.ec2client, input);
            update = true;
          }
          if (
            !(
              Object.is(cloudRecord.subnets?.length, e.subnets?.length) &&
              !!cloudRecord.subnets?.every((s: any) => !!e.subnets?.find(esub => Object.is(s.id, esub.id)))
            )
          ) {
            // get a list of the subnet ids
            const oldSubnetIds = [];
            for (const s of cloudRecord.subnets) {
              if (s.subnetId) oldSubnetIds.push(s.subnetId);
            }

            const newSubnetIds = [];
            for (const s of e.subnets) {
              if (s.subnetId) newSubnetIds.push(s.subnetId);
            }

            // VPC endpoint route tables update
            const input: ModifyVpcEndpointCommandInput = {
              VpcEndpointId: e.vpcEndpointId,
            };
            if (oldSubnetIds.length) {
              input.RemoveSubnetIds = oldSubnetIds;
            }
            if (newSubnetIds.length) {
              input.AddSubnetIds = newSubnetIds;
            }
            await modifyVpcEndpoint(client.ec2client, input);
            update = true;
          }
          if (!eqTags(cloudRecord.tags, e.tags)) {
            // Tags update
            await updateTags(client.ec2client, e.vpcEndpointId ?? '', e.tags);
            update = true;
          }
          if (update) {
            // wait to be available
            const result = await this.waitForEndpointAvailable(client.ec2client, e?.vpcEndpointId ?? '');
            if (result.state === WaiterState.SUCCESS) continue;

            const rawEndpoint = await getVpcEndpoint(client.ec2client, e.vpcEndpointId ?? '');
            if (!rawEndpoint) continue;
            const newEndpoint = await this.endpointInterfaceMapper(rawEndpoint, e.region, ctx);
            if (!newEndpoint) continue;
            newEndpoint.id = e.id;
            await this.module.endpointInterface.db.update(newEndpoint, ctx);
            out.push(newEndpoint);
          } else {
            // Restore record
            cloudRecord.id = e.id;
            await this.module.endpointInterface.db.update(cloudRecord, ctx);
            out.push(cloudRecord);
          }
        } else {
          // Replace record
          let newEndpoint;
          newEndpoint = await this.module.endpointInterface.cloud.create(e, ctx);
          await this.module.endpointInterface.cloud.delete(cloudRecord, ctx);
          out.push(newEndpoint);
        }
      }
      return out;
    },
    delete: async (es: EndpointInterface[], ctx: Context) => {
      for (const e of es) {
        const client = (await ctx.getAwsClient(e.region)) as AWS;
        await deleteVpcEndpoint(client.ec2client, e.vpcEndpointId ?? '');

        // wait until it does not exist
        const result = await this.waitForEndpointDeleted(client.ec2client, e?.vpcEndpointId ?? '');
      }
    },
  });

  constructor(module: AwsVpcModule) {
    super();
    this.module = module;
    super.init();
  }
}
