import {
  EC2,
  RunInstancesCommandInput,
  DescribeInstancesCommandInput,
  paginateDescribeInstances,
  Volume as AWSVolume,
  DescribeVolumesCommandInput,
} from '@aws-sdk/client-ec2';
import { Instance as AWSInstance, InstanceLifecycle, Tag as AWSTag } from '@aws-sdk/client-ec2';
import { SSM } from '@aws-sdk/client-ssm';
import { createWaiter, WaiterState } from '@aws-sdk/util-waiter';

import { AwsEc2Module } from '..';
import { awsIamModule, awsSecurityGroupModule, awsVpcModule } from '../..';
import { AWS, crudBuilder2, crudBuilderFormat, paginateBuilder } from '../../../services/aws_macros';
import { Context, Crud2, MapperBase } from '../../interfaces';
import { GeneralPurposeVolume, Instance, State, VolumeState } from '../entity';
import { updateTags, eqTags } from './tags';

export class InstanceMapper extends MapperBase<Instance> {
  module: AwsEc2Module;
  entity = Instance;
  equals = (a: Instance, b: Instance) =>
    Object.is(a.state, b.state) && this.instanceEqReplaceableFields(a, b) && eqTags(a.tags, b.tags);

  instanceEqReplaceableFields(a: Instance, b: Instance) {
    return (
      Object.is(a.instanceId, b.instanceId) &&
      Object.is(a.ami, b.ami) &&
      Object.is(a.instanceType, b.instanceType) &&
      Object.is(a.userData, b.userData) &&
      Object.is(a.keyPairName, b.keyPairName) &&
      Object.is(a.securityGroups?.length, b.securityGroups?.length) &&
      a.securityGroups?.every(as => !!b.securityGroups?.find(bs => Object.is(as.groupId, bs.groupId))) &&
      Object.is(a.role?.arn, b.role?.arn) &&
      Object.is(a.subnet?.subnetId, b.subnet?.subnetId) &&
      Object.is(a.hibernationEnabled, b.hibernationEnabled)
    );
  }

  async instanceMapper(instance: AWSInstance, region: string, ctx: Context) {
    const client = (await ctx.getAwsClient(region)) as AWS;
    const out = new Instance();
    if (!instance.InstanceId) return undefined;
    out.instanceId = instance.InstanceId;
    const tags: { [key: string]: string } = {};
    (instance.Tags || [])
      .filter(t => !!t.Key && !!t.Value)
      .forEach(t => {
        tags[t.Key as string] = t.Value as string;
      });
    out.tags = tags;
    const userDataBase64 = await this.getInstanceUserData(client.ec2client, out.instanceId);
    out.userData = userDataBase64 ? Buffer.from(userDataBase64, 'base64').toString('ascii') : undefined;
    if (instance.State?.Name === State.STOPPED) out.state = State.STOPPED;
    // map interim states to running
    else out.state = State.RUNNING;
    out.ami = instance.ImageId ?? '';
    if (instance.KeyName) out.keyPairName = instance.KeyName;
    out.instanceType = instance.InstanceType ?? '';
    if (!out.instanceType) return undefined;
    out.securityGroups = [];
    for (const sgId of instance.SecurityGroups?.map(sg => sg.GroupId) ?? []) {
      const sg = await awsSecurityGroupModule.securityGroup.db.read(
        ctx,
        awsSecurityGroupModule.securityGroup.generateId({ groupId: sgId ?? '', region }),
      );
      if (sg) out.securityGroups.push(sg);
    }
    if (instance.IamInstanceProfile?.Arn) {
      const roleName = awsIamModule.role.roleNameFromArn(instance.IamInstanceProfile.Arn, ctx);
      try {
        const role =
          (await awsIamModule.role.db.read(ctx, roleName)) ??
          (await awsIamModule.role.cloud.read(ctx, roleName));
        if (role) {
          out.role = role;
        }
      } catch (_) {
        /** Do nothing */
      }
    }
    out.subnet =
      (await awsVpcModule.subnet.db.read(
        ctx,
        awsVpcModule.subnet.generateId({ subnetId: instance.SubnetId ?? '', region }),
      )) ??
      (await awsVpcModule.subnet.cloud.read(
        ctx,
        awsVpcModule.subnet.generateId({ subnetId: instance.SubnetId ?? '', region }),
      ));
    out.hibernationEnabled = instance.HibernationOptions?.Configured ?? false;
    out.region = region;
    return out;
  }

  getInstanceUserData = crudBuilderFormat<EC2, 'describeInstanceAttribute', string | undefined>(
    'describeInstanceAttribute',
    InstanceId => ({ Attribute: 'userData', InstanceId }),
    res => res?.UserData?.Value,
  );

  getVolumesByInstanceId = crudBuilderFormat<EC2, 'describeVolumes', AWSVolume[] | undefined>(
    'describeVolumes',
    instanceId => ({
      Filters: [
        {
          Name: 'attachment.instance-id',
          Values: [instanceId],
        },
      ],
    }),
    res => res?.Volumes,
  );

  getParameter = crudBuilder2<SSM, 'getParameter'>('getParameter', Name => ({ Name }));

  describeImages = crudBuilder2<EC2, 'describeImages'>('describeImages', ImageIds => ({
    ImageIds,
  }));

  describeInstances = crudBuilder2<EC2, 'describeInstances'>('describeInstances', InstanceIds => ({
    InstanceIds,
  }));

  async getInstance(client: EC2, id: string) {
    const reservations = await this.describeInstances(client, [id]);
    return (reservations?.Reservations?.map((r: any) => r.Instances) ?? []).pop()?.pop();
  }

  getInstances = paginateBuilder<EC2>(paginateDescribeInstances, 'Instances', 'Reservations');

  // TODO: Macro-ify the waiter usage
  async newInstance(client: EC2, newInstancesInput: RunInstancesCommandInput): Promise<string> {
    const create = await client.runInstances(newInstancesInput);
    const instanceIds: string[] | undefined = create.Instances?.map(i => i?.InstanceId ?? '');
    const input: DescribeInstancesCommandInput = {
      InstanceIds: instanceIds,
    };
    // TODO: should we use the paginator instead?
    await createWaiter<EC2, DescribeInstancesCommandInput>(
      {
        client,
        // all in seconds
        maxWaitTime: 300,
        minDelay: 1,
        maxDelay: 4,
      },
      input,
      async (cl, cmd) => {
        try {
          const data = await cl.describeInstances(cmd);
          for (const reservation of data?.Reservations ?? []) {
            for (const instance of reservation?.Instances ?? []) {
              if (instance.PublicIpAddress === undefined || instance.State?.Name !== 'running')
                return { state: WaiterState.RETRY };
            }
          }
          return { state: WaiterState.SUCCESS };
        } catch (e: any) {
          if (e.Code === 'InvalidInstanceID.NotFound') return { state: WaiterState.RETRY };
          throw e;
        }
      },
    );
    return instanceIds?.pop() ?? '';
  }

  // TODO: Figure out if/how to macro-ify this thing
  async volumeWaiter(
    client: EC2,
    volumeId: string,
    handleState: (vol: AWSVolume | undefined) => { state: WaiterState },
  ) {
    return createWaiter<EC2, DescribeVolumesCommandInput>(
      {
        client,
        // all in seconds
        maxWaitTime: 300,
        minDelay: 1,
        maxDelay: 4,
      },
      {
        VolumeIds: [volumeId],
      },
      async (cl, input) => {
        const data = await cl.describeVolumes(input);
        try {
          const vol = data.Volumes?.pop();
          return handleState(vol);
        } catch (e: any) {
          throw e;
        }
      },
    );
  }

  waitUntilInUse(client: EC2, volumeId: string) {
    return this.volumeWaiter(client, volumeId, (vol: AWSVolume | undefined) => {
      // If state is not 'in-use' retry
      if (!Object.is(vol?.State, VolumeState.IN_USE)) {
        return { state: WaiterState.RETRY };
      }
      return { state: WaiterState.SUCCESS };
    });
  }

  waitUntilDeleted(client: EC2, volumeId: string) {
    return this.volumeWaiter(client, volumeId, (vol: AWSVolume | undefined) => {
      // If state is not 'in-use' retry
      if (!Object.is(vol?.State, VolumeState.DELETED)) {
        return { state: WaiterState.RETRY };
      }
      return { state: WaiterState.SUCCESS };
    });
  }

  // TODO: More to fix
  async startInstance(client: EC2, instanceId: string) {
    await client.startInstances({
      InstanceIds: [instanceId],
    });
    const input: DescribeInstancesCommandInput = {
      InstanceIds: [instanceId],
    };
    await createWaiter<EC2, DescribeInstancesCommandInput>(
      {
        client,
        // all in seconds
        maxWaitTime: 300,
        minDelay: 1,
        maxDelay: 4,
      },
      input,
      async (cl, cmd) => {
        try {
          const data = await cl.describeInstances(cmd);
          for (const reservation of data?.Reservations ?? []) {
            for (const instance of reservation?.Instances ?? []) {
              if (instance.State?.Name !== 'running') return { state: WaiterState.RETRY };
            }
          }
          return { state: WaiterState.SUCCESS };
        } catch (e: any) {
          if (e.Code === 'InvalidInstanceID.NotFound') return { state: WaiterState.SUCCESS };
          throw e;
        }
      },
    );
  }

  // TODO: Macro-ify this
  async stopInstance(client: EC2, instanceId: string, hibernate = false) {
    await client.stopInstances({
      InstanceIds: [instanceId],
      Hibernate: hibernate,
    });
    const input: DescribeInstancesCommandInput = {
      InstanceIds: [instanceId],
    };
    await createWaiter<EC2, DescribeInstancesCommandInput>(
      {
        client,
        // all in seconds
        maxWaitTime: 300,
        minDelay: 1,
        maxDelay: 4,
      },
      input,
      async (cl, cmd) => {
        try {
          const data = await cl.describeInstances(cmd);
          for (const reservation of data?.Reservations ?? []) {
            for (const instance of reservation?.Instances ?? []) {
              if (instance.State?.Name !== 'stopped') return { state: WaiterState.RETRY };
            }
          }
          return { state: WaiterState.SUCCESS };
        } catch (e: any) {
          if (e.Code === 'InvalidInstanceID.NotFound') return { state: WaiterState.SUCCESS };
          throw e;
        }
      },
    );
  }

  terminateInstance = crudBuilderFormat<EC2, 'terminateInstances', undefined>(
    'terminateInstances',
    id => ({ InstanceIds: [id] }),
    _res => undefined,
  );

  cloud: Crud2<Instance> = new Crud2({
    create: async (es: Instance[], ctx: Context) => {
      const out = [];
      for (const instance of es) {
        const client = (await ctx.getAwsClient(instance.region)) as AWS;
        const previousInstanceId = instance.instanceId;
        if (instance.ami) {
          let tgs: AWSTag[] = [];
          if (instance.tags !== undefined) {
            const tags: { [key: string]: string } = instance.tags;
            tags.owner = 'iasql-engine';
            tgs = Object.keys(tags).map(k => {
              return {
                Key: k,
                Value: tags[k],
              };
            });
          }

          // check if we have some entry without security group id
          const without = instance.securityGroups.filter(sg => !sg.groupId);
          if (without.length > 0) continue;

          const sgIds = instance.securityGroups.map(sg => sg.groupId).filter(id => !!id) as string[];

          const userData = instance.userData ? Buffer.from(instance.userData).toString('base64') : undefined;
          const iamInstanceProfile = instance.role?.arn
            ? { Arn: instance.role.arn.replace(':role/', ':instance-profile/') }
            : undefined;
          if (instance.subnet && !instance.subnet.subnetId) {
            throw new Error('Subnet assigned but not created yet in AWS');
          }
          const instanceParams: RunInstancesCommandInput = {
            ImageId: instance.ami,
            InstanceType: instance.instanceType,
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [
              {
                ResourceType: 'instance',
                Tags: tgs,
              },
            ],
            KeyName: instance.keyPairName,
            UserData: userData,
            IamInstanceProfile: iamInstanceProfile,
            SubnetId: instance.subnet?.subnetId,
          };
          // Add security groups if any
          if (sgIds?.length) {
            instanceParams.SecurityGroupIds = sgIds;
          }
          if (instance.hibernationEnabled) {
            let amiId;
            // Resolve amiId if necessary
            if (instance.ami.includes('resolve:ssm:')) {
              const amiPath = instance.ami.split('resolve:ssm:').pop() ?? '';
              const ssmParameter = await this.getParameter(client.ssmClient, amiPath);
              amiId = ssmParameter?.Parameter?.Value;
            } else {
              amiId = instance.ami;
            }
            // Get AMI image
            const amiImage = (await this.describeImages(client.ec2client, [amiId]))?.Images?.pop();
            // Update input object
            instanceParams.HibernationOptions = {
              Configured: true,
            };
            instanceParams.BlockDeviceMappings = [
              {
                DeviceName: amiImage?.RootDeviceName,
                Ebs: {
                  Encrypted: true,
                },
              },
            ];
          }
          const instanceId = await this.newInstance(client.ec2client, instanceParams);
          if (!instanceId) {
            // then who?
            throw new Error('should not be possible');
          }
          const newEntity = await this.module.instance.cloud.read(
            ctx,
            this.module.instance.generateId({ instanceId, region: instance.region }),
          );
          newEntity.id = instance.id;
          await this.module.instance.db.update(newEntity, ctx);
          out.push(newEntity);
          // Attach volume
          const rawAttachedVolume = (await this.getVolumesByInstanceId(client.ec2client, instanceId))?.pop();
          await this.waitUntilInUse(client.ec2client, rawAttachedVolume?.VolumeId ?? '');
          delete ctx?.memo?.cloud?.GeneralPurposeVolume?.[
            this.module.generalPurposeVolume.generateId({
              volumeId: rawAttachedVolume?.VolumeId ?? '',
              region: instance.region,
            })
          ];
          const attachedVolume: GeneralPurposeVolume = await this.module.generalPurposeVolume.cloud.read(
            ctx,
            this.module.generalPurposeVolume.generateId({
              volumeId: rawAttachedVolume?.VolumeId ?? '',
              region: newEntity.region,
            }),
          );
          if (attachedVolume && !Array.isArray(attachedVolume)) {
            attachedVolume.attachedInstance = newEntity;
            // If this is a replace path, there could be already a root volume in db, we need to
            // find it and delete it before creating the new one.
            if (previousInstanceId) {
              const rawPreviousInstance: AWSInstance = await this.getInstance(
                client.ec2client,
                previousInstanceId,
              );
              const dbAttachedVolume = await ctx.orm.findOne(GeneralPurposeVolume, {
                where: {
                  attachedInstance: {
                    id: newEntity.id,
                  },
                  instanceDeviceName: rawPreviousInstance.RootDeviceName,
                },
                relations: ['attachedInstance'],
              });
              if (dbAttachedVolume) await this.module.generalPurposeVolume.db.delete(dbAttachedVolume, ctx);
            }
            await this.module.generalPurposeVolume.db.create(attachedVolume, ctx);
          }
        }
      }
      return out;
    },
    read: async (ctx: Context, id?: string) => {
      if (id) {
        const { instanceId, region } = this.idFields(id);
        const client = (await ctx.getAwsClient(region)) as AWS;
        const rawInstance = await this.getInstance(client.ec2client, instanceId);
        // exclude spot instances
        if (!rawInstance || rawInstance.InstanceLifecycle === InstanceLifecycle.SPOT) return;
        if (rawInstance.State?.Name === 'terminated' || rawInstance.State?.Name === 'shutting-down') return;
        return this.instanceMapper(rawInstance, region, ctx);
      } else {
        const out: Instance[] = [];
        const enabledRegions = (await ctx.getEnabledAwsRegions()) as string[];
        await Promise.all(
          enabledRegions.map(async region => {
            const client = (await ctx.getAwsClient(region)) as AWS;
            const rawInstances = (await this.getInstances(client.ec2client)) ?? [];
            for (const i of rawInstances) {
              if (i?.State?.Name === 'terminated' || i?.State?.Name === 'shutting-down') continue;
              const outInst = await this.instanceMapper(i, region, ctx);
              if (outInst) out.push(outInst);
            }
          }),
        );
        return out;
      }
    },
    updateOrReplace: (a: Instance, b: Instance) =>
      this.instanceEqReplaceableFields(a, b) ? 'update' : 'replace',
    update: async (es: Instance[], ctx: Context) => {
      const out = [];
      for (const e of es) {
        const client = (await ctx.getAwsClient(e.region)) as AWS;
        const cloudRecord = ctx?.memo?.cloud?.Instance?.[this.entityId(e)];
        if (this.instanceEqReplaceableFields(e, cloudRecord)) {
          const insId = e.instanceId as string;
          if (!eqTags(e.tags, cloudRecord.tags) && e.instanceId && e.tags) {
            await updateTags(client.ec2client, insId, e.tags);
          }
          if (!Object.is(e.state, cloudRecord.state) && e.instanceId) {
            if (cloudRecord.state === State.STOPPED && e.state === State.RUNNING) {
              await this.startInstance(client.ec2client, insId);
            } else if (cloudRecord.state === State.RUNNING && e.state === State.STOPPED) {
              await this.stopInstance(client.ec2client, insId);
            } else if (cloudRecord.state === State.RUNNING && e.state === State.HIBERNATE) {
              await this.stopInstance(client.ec2client, insId, true);
              e.state = State.STOPPED;
              await this.module.instance.db.update(e, ctx);
            } else {
              // TODO: This throw will interrupt the other EC2 updates. Is that alright?
              throw new Error(
                `Invalid instance state transition. From CLOUD state ${cloudRecord.state} to DB state ${e.state}`,
              );
            }
          }
          out.push(e);
        } else {
          const created = (await this.module.instance.cloud.create(e, ctx)) as Instance;
          // TODO: Remove this weirdness once the `iasql_commit` logic can handle nested entity changes
          delete ctx?.memo?.db?.RegisteredInstance;
          const registeredInstances = await this.module.registeredInstance.db.read(ctx);
          for (const re of registeredInstances) {
            if (re.instance.instanceId === created.instanceId) {
              await this.module.registeredInstance.cloud.create(re, ctx);
            }
          }
          for (const k of Object.keys(ctx?.memo?.cloud?.RegisteredInstance ?? {})) {
            if (k.split('|')[0] === cloudRecord.instanceId) {
              const re = ctx.memo.cloud.RegisteredInstance[k];
              await this.module.registeredInstance.cloud.delete(re, ctx);
            }
          }
          await this.module.instance.cloud.delete(cloudRecord, ctx);
          out.push(created);
        }
      }
      return out;
    },
    delete: async (es: Instance[], ctx: Context) => {
      for (const entity of es) {
        const client = (await ctx.getAwsClient(entity.region)) as AWS;
        // Remove attached volume
        const rawAttachedVolume = (
          await this.getVolumesByInstanceId(client.ec2client, entity.instanceId ?? '')
        )?.pop();
        if (entity.instanceId) await this.terminateInstance(client.ec2client, entity.instanceId);
        await this.waitUntilDeleted(client.ec2client, rawAttachedVolume?.VolumeId ?? '');
        delete ctx?.memo?.cloud?.GeneralPurposeVolume?.[
          this.module.generalPurposeVolume.generateId({
            volumeId: rawAttachedVolume?.VolumeId ?? '',
            region: entity.region,
          })
        ];
        delete ctx?.memo?.db?.GeneralPurposeVolume?.[
          this.module.generalPurposeVolume.generateId({
            volumeId: rawAttachedVolume?.VolumeId ?? '',
            region: entity.region,
          })
        ];
        const attachedVolume = await this.module.generalPurposeVolume.db.read(
          ctx,
          this.module.generalPurposeVolume.generateId({
            volumeId: rawAttachedVolume?.VolumeId ?? '',
            region: entity.region,
          }),
        );
        if (attachedVolume && !Array.isArray(attachedVolume))
          await this.module.generalPurposeVolume.db.delete(attachedVolume, ctx);
      }
    },
  });

  constructor(module: AwsEc2Module) {
    super();
    this.module = module;
    super.init();
  }
}
