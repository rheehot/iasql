import {
  paginateListSubscriptions,
  paginateListSubscriptionsByTopic,
  SNS,
  Subscription as SubscriptionAWS,
} from '@aws-sdk/client-sns';

import { AwsSnsModule } from '..';
import { AWS, paginateBuilder } from '../../../services/aws_macros';
import { Context, Crud2, MapperBase } from '../../interfaces';
import { Subscription } from '../entity/subscription';

export class SubscriptionMapper extends MapperBase<Subscription> {
  module: AwsSnsModule;
  entity = Subscription;
  equals = (a: Subscription, b: Subscription) => {
    return Object.is(a.arn, b.arn) && Object.is(a.endpoint, b.endpoint) && Object.is(a.protocol, b.protocol);
  };

  async subscriptionMapper(s: SubscriptionAWS, region: string, ctx: Context) {
    const out = new Subscription();
    if (!s.SubscriptionArn || !s.Protocol || !s.TopicArn) return undefined;

    out.arn = s.SubscriptionArn;
    out.endpoint = s.Endpoint;
    out.protocol = s.Protocol;
    out.region = region;

    // read topic from ARN
    try {
      out.topic =
        (await this.module.topic.db.read(
          ctx,
          this.module.topic.generateId({ arn: s.TopicArn ?? '', region }),
        )) ??
        (await this.module.topic.cloud.read(
          ctx,
          this.module.topic.generateId({ arn: s.TopicArn ?? '', region }),
        ));
    } catch (e) {
      // for non-confirmed subscriptions, topic may not exist, so do not map it
      return undefined;
    }

    return out;
  }

  listSubscriptionsByTopic = paginateBuilder<SNS>(
    paginateListSubscriptionsByTopic,
    'listSubscriptionsByTopic',
    undefined,
    undefined,
    topicArn => ({ TopicArn: topicArn }),
  );

  listSubscriptions = paginateBuilder<SNS>(paginateListSubscriptions, 'Subscriptions');

  cloud: Crud2<Subscription> = new Crud2({
    create: async (es: Subscription[], ctx: Context) => {
      // Just immediately revert, we can't create subscriptions without the RPC
      const out = await this.module.subscription.db.delete(es, ctx);
      if (!out || out instanceof Array) return out;
      return [out];
    },
    read: async (ctx: Context, id?: string) => {
      const enabledRegions = (await ctx.getEnabledAwsRegions()) as string[];
      if (!!id) {
        const { topic, endpoint, region } = this.idFields(id);

        if (enabledRegions.includes(region)) {
          const client = (await ctx.getAwsClient(region)) as AWS;

          // retrieve all subscriptions and find the right one
          const subscriptions = await this.listSubscriptionsByTopic(client.snsClient, topic);
          for (const subscription of subscriptions) {
            if (subscription.Endpoint === endpoint) {
              const entry = await this.subscriptionMapper(subscription, region, ctx);
              return entry;
            }
          }
        }
      } else {
        const out: Subscription[] = [];
        await Promise.all(
          enabledRegions.map(async region => {
            const client = (await ctx.getAwsClient(region)) as AWS;
            const subs = (await this.listSubscriptions(client.snsClient)) ?? [];
            for (const s of subs) {
              const mappedSubscription = await this.subscriptionMapper(s, region, ctx);
              if (mappedSubscription) out.push(mappedSubscription);
            }
          }),
        );
        return out;
      }
    },
    update: async (es: Subscription[], ctx: Context) => {
      // Right now we can only modify AWS-generated fields in the database.
      // This implies that on `update`s we only have to restore the values for those records.
      const out = [];
      for (const e of es) {
        if (e.arn) {
          const arn = e.arn;
          const region = e.region;
          const cloudRecord = ctx?.memo?.cloud?.Subscription?.[this.generateId({ arn, region })];
          cloudRecord.id = e.id;
          await this.module.subscription.db.update(cloudRecord, ctx);
          out.push(cloudRecord);
        }
      }
      return out;
    },
    delete: async (es: Subscription[], ctx: Context) => {
      // You can't delete subscriptions, just restore them back
      const out = await this.module.subscription.db.create(es, ctx);
      if (!out || out instanceof Array) return out;
      return [out];
    },
  });

  constructor(module: AwsSnsModule) {
    super();
    this.module = module;
    super.init();
  }
}
