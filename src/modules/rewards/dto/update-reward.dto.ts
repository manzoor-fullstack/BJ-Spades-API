import { PartialType } from '@nestjs/swagger';

import { CreateRewardDto } from './create-reward.dto';

/**
 * Every create field, all optional.
 *
 * `PartialType` is honest here in a way it would not be for tournaments: a
 * reward has no status transition table and no pair of fields that must travel
 * together, so there is genuinely nothing to say beyond "the same, optional".
 *
 * The image is replaced by attaching a new `image` part, exactly as on create.
 */
export class UpdateRewardDto extends PartialType(CreateRewardDto) {}
