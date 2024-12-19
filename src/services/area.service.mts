import type { ByIdProxy, ENTITY_STATE, PICK_ENTITY } from '@digital-alchemy/hass'
import type { SceneControllerInput, SceneControllerOptions } from './scene.service.mjs'
import { InternalError, type TServiceParams } from '@digital-alchemy/core'
import { useTimer, type UseTimerOutput } from '../helpers/timer.mjs'
import { sceneController } from './scene.service.mjs'

// TODO: fix switch icons
// TODO: see about integrating actual home assistant scenes
// TODO: document better
// TODO: test

type AreaState = 'vacant' | 'occupied'
type Action<TParams extends any[]> = (...params: TParams) => void
type Condition = () => boolean
// Not sure how to type this. 
// ByIdProxy<PICK_ENTITY> works for entities returned from hass.refBy.id but not for synapse entity return type
type Trigger = ByIdProxy<PICK_ENTITY>

interface AreaServiceInput {
  id: string
  friendlyName?: string
  // area state triggers for 'occupied' and 'vacant'
  triggers?: Trigger[]
  conditions?: Array<Condition>
  // custom function to determine area state, runs when update is triggered.
  current?: (state: AreaState) => AreaState
  presence?: {
    sensors: PresenceControllerInput['sensors']
  }
  // scene config
  scenes?: Pick<
    SceneControllerInput,
    'conditions' | 'definitions' | 'off' | 'triggers'
  > & { options: SceneControllerOptions }
}

interface AreaServiceOptions {
  // triggerType?: 'motion'
}

/**
 * Area Service
 *
 * Manages the state of an area, determining whether it is "occupied" or "vacant" based on presence triggers
 * or a custom callback. Optionally integrates with scene controllers to adjust scenes based on area state.
 *
 * @param input.name - name for the area. Name is used to create various sensors & ui entities.
 * @param input.triggers - home assistant entities that trigger presence updates. (motiton sensors etc)
 * @param input.current - (optional) Custom function to determine occupancy state if not using motion sensors.
 * @param input.scenes - (optional) Provide scenes for the area.
 * 
 * @returns
 *  - `onInit`: initialization hook
 *  - `onUpdate`: update hook
 */
export function defineAreaConfig(ctx: TServiceParams, input: AreaServiceInput, opts: AreaServiceOptions = {}) {
  const {
  } = opts

  const {
    id,
    friendlyName = id,
    current,
    presence,
    scenes,
    triggers,
  } = input

  let _getStateCurrentValue = current
  let _getCurrent: () => AreaState
  let setTimeout: UseTimerOutput['setDuration']
  const _triggers = [...triggers]
  const actions: {
    init: (() => void)[],
    // update hook cb gets passed next & prev ctx, need help with types here.
    update: Action<[
      NonNullable<ENTITY_STATE<PICK_ENTITY>>,
      NonNullable<ENTITY_STATE<PICK_ENTITY>>
    ]>[]
  } = {
    init: [],
    update: [],
  }

  if (presence) {
    const {
      getAreaOccupancy,
      timeout,
      setTimeout: setSceneTimeout,
    } = presenceController({ id: id, sensors: presence.sensors, ctx })

    // set state sensor current function
    _getStateCurrentValue = getAreaOccupancy

    // pass setTimeout to scene controller
    setTimeout = setSceneTimeout

    // add timeout to state triggers
    // @ts-expect-error - not sure how to properly type a synapse sensor vs hass sensor
    _triggers.push(timeout)

    // add presence sensors to state update triggers
    presence.sensors.forEach(sensor => _triggers.push(sensor))
  }

  if (!_getStateCurrentValue) {
    throw new InternalError(
      ctx.context,
      `[AREA][${id.toUpperCase()}]`,
      `No state current callback defined. Must either define current or set triggerType = motion`,
    )
  }

  const state = ctx.synapse.sensor<{ state: AreaState }>({
    context: ctx.context,
    name: `${friendlyName} State`,
    options: ['vacant', 'occupied'] as const,
    state: {
      onUpdate: _triggers,
      current: () => _getCurrent(),
    },
  })

  _getCurrent = () => _getStateCurrentValue(state.state)

  // scene controller
  if (scenes) {
    const { triggers, conditions, ...rest } = scenes

    // add occupied condtion to scene condtions
    const updatedConditions = [
      ...conditions,
      () => state.state === 'occupied'
    ]

    // add area state sensor to trigger scene state updates.
    const updatedTriggers = [...triggers, state]

    const { init } = sceneController({
      ctx,
      id,
      areaName: friendlyName,
      conditions: updatedConditions,
      setTimeout,
      triggers: updatedTriggers,
      ...rest,
    })

    actions.init.push(init)
  }

  function init() {
    actions.init.forEach(action => action())

    state.onUpdate((next, prev) => {
      if (next.state === prev.state)
        return

      actions.update.forEach(action => action(next, prev))
    })
  }

  function onInit(cb: () => void) {
    actions.init.push(cb)
  }

  function onUpdate(cb: () => void) {
    actions.update.push(cb)
  }

  ctx.lifecycle.onReady(() => init())

  return {
    // returns hooks
    onInit,
    onUpdate,
  }
}

interface PresenceControllerInput {
  ctx: TServiceParams
  id: string
  friendlyName?: string
  sensors: ByIdProxy<PICK_ENTITY<'binary_sensor'>>[]
}

/**
 * Presence Controller
 *
 * Monitors presence sensors. motion=occupied, vacant=no motion within timeout period.
 *
 * @returns
 * - `getAreaOccupancy`: Function to determine occupancy state of the area.
 * - `setTimeout`: Function to set the timeout duration.
 * - `timeout`: timeout binary sensor. is_on=true indicates the timer has reached 0.
 */
export function presenceController(input: PresenceControllerInput) {
  const { ctx, id, friendlyName, sensors } = input

  // sensor for timeout, to trigger area state update
  const timeout = ctx.synapse.binary_sensor({
    context: ctx.context,
    name: `${friendlyName ?? id} presence timeout`,
    is_on: false,
  })

  const { start, restart, setDuration, onEnd } = useTimer()

  // set timeout state when timer ends
  onEnd(() => timeout.is_on = true)

  // update state based on presenseSensors
  function getAreaOccupancy(state: AreaState) {
    const hasMotion = sensors.some(sensor => sensor.state === 'on')
    const timedOut = timeout.is_on
    const isOccupied = state === 'occupied'

    if (timedOut && isOccupied)
      return 'vacant'

    if (!hasMotion)
      return state

    if (isOccupied) {
      ctx.logger.info('[PRESENCE CONTROLLER] Occupied with motion. Re-upping timer.')
      restart()
      return 'occupied'
    }
    else {
      ctx.logger.info('[PRESENCE CONTROLLER] Vacant with motion. Starting timer.')
      start(() => timeout.is_on = false)
      return 'occupied'
    }
  }

  return {
    getAreaOccupancy,
    setTimeout: setDuration,
    timeout,
  }
}
