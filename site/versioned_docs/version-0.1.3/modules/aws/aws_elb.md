---
id: "aws_elb"
title: "aws_elb"
hide_table_of_contents: true
custom_edit_url: null
displayed_sidebar: "docs"
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="Components" label="Components" default>

### Tables

    [listener](../../aws/tables/aws_elb_entity_listener.Listener)

    [load_balancer](../../aws/tables/aws_elb_entity_load_balancer.LoadBalancer)

    [target_group](../../aws/tables/aws_elb_entity_target_group.TargetGroup)

### Enums
    [action_type](../../aws/enums/aws_elb_entity_listener.ActionTypeEnum)

    [ip_address_type](../../aws/enums/aws_elb_entity_load_balancer.IpAddressType)

    [load_balancer_scheme](../../aws/enums/aws_elb_entity_load_balancer.LoadBalancerSchemeEnum)

    [load_balancer_state](../../aws/enums/aws_elb_entity_load_balancer.LoadBalancerStateEnum)

    [load_balancer_type](../../aws/enums/aws_elb_entity_load_balancer.LoadBalancerTypeEnum)

    [protocol](../../aws/enums/aws_elb_entity_target_group.ProtocolEnum)

    [protocol_version](../../aws/enums/aws_elb_entity_target_group.ProtocolVersionEnum)

    [target_group_ip_address_type](../../aws/enums/aws_elb_entity_target_group.TargetGroupIpAddressTypeEnum)

    [target_type](../../aws/enums/aws_elb_entity_target_group.TargetTypeEnum)

</TabItem>
  <TabItem value="Code examples" label="Code examples">

```testdoc
modules/aws-elb-integration.ts#ELB Integration Testing#Manage ELB
```

</TabItem>
</Tabs>
