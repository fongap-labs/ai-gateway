// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Compatibility entrypoint for existing integrations; active Worker lives in apps/.
export { handlePerceptionCenterRequest } from '../../apps/perception/index.ts';

import perceptionCenter from '../../apps/perception/index.ts';
export default perceptionCenter;
