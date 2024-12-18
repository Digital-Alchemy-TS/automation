import type { ByIdProxy, PICK_ENTITY } from '@digital-alchemy/hass'
import type { SceneControllerInput } from './scene.service.mjs'
import { InternalError, type TServiceParams } from '@digital-alchemy/core'
import { useTimer, type UseTimerOutput } from '../helpers/timer.mjs'
import { sceneController } from './scene.service.mjs'

// TODO: fix switch names & icons
// TODO: Service should return hooks
// TODO: see about integrating actual home assistant scenes
// TODO: document better
// TODO: get feedback
// TODO: test

type AreaState = 'vacant' | 'occupied'

interface AreaServiceInput {
  name: string
  triggers?: ByIdProxy<PICK_ENTITY<'binary_sensor'>>[]
  current?: (state: AreaState) => AreaState
  scenes?: Pick<
    SceneControllerInput,
    'conditions' | 'definitions' | 'off' | 'triggers'
  >
}

interface AreaServiceOptions {
  triggerType?: 'motion'
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
 * @param opts.triggerType - (optional) Set to 'motion' if you are providing presence sensors for the area to monitor.
 * No need to provide an input.current function, occupancy is handled by the service.
 */
export function defineAreaConfig(ctx: TServiceParams, input: AreaServiceInput, opts: AreaServiceOptions = {}) {
  const {
    triggerType,
  } = opts

  const {
    name,
    current,
    scenes,
    triggers,
  } = input

  let _getStateCurrentValue = current
  let setTimeout: UseTimerOutput['setDuration']
  const _triggers = [...triggers]
  const actions: Record<string, (() => void)[]> = {
    init: [],
    occupied: [],
    vacant: [],
  }

  if (triggerType === 'motion') {
    const {
      getAreaOccupancy,
      timeout,
      setTimeout: setSceneTimeout,
    } = presenceController({ name, presenceSensors: triggers, ctx })

    // set state sensor current function
    _getStateCurrentValue = getAreaOccupancy

    // pass setTimeout to scene controller
    setTimeout = setSceneTimeout

    // add timeout to state triggers
    // @ts-expect-error - not sure how to properly type a synapse sensor vs hass sensor
    _triggers.push(timeout)
  }

  if (!_getStateCurrentValue) {
    throw new InternalError(
      ctx.context,
      `[AREA][${name.toUpperCase()}]`,
      `No state current callback defined. Must either define current or set triggerType = motion`,
    )
  }

  const state = ctx.synapse.sensor<{ state: AreaState }>({
    context: ctx.context,
    name: `${name} State`,
    options: ['vacant', 'occupied'] as const,
    state: {
      onUpdate: _triggers,
      current: () => _getStateCurrentValue(state.state),
    },
  })

  function _onVacant() {
    ctx.logger.info(`[AREA][${name.toUpperCase()}] Vacant`)
  }

  function _onOccupied() {
    ctx.logger.info(`[AREA][${name.toUpperCase()}] Occupied`)
  }

  // scene controller
  if (scenes) {
    const { triggers, conditions, ...rest } = scenes

    // add occupied condtion to scene condtions
    const updatedConditions = [...conditions, () => state.state === 'occupied']

    // add area state sensor to trigger scene state updates.
    const updatedTriggers = [...triggers, state]

    const { init } = sceneController({
      ctx,
      name,
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

      if (next.state === 'occupied')
        _onOccupied()

      if (next.state === 'vacant')
        _onVacant()
    })
  }

  ctx.lifecycle.onReady(() => init())
}

interface PresenceControllerInput {
  ctx: TServiceParams
  name: string
  presenceSensors: ByIdProxy<PICK_ENTITY<'binary_sensor'>>[]
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
  const { ctx, name, presenceSensors } = input

  // sensor for timeout, to trigger area state update
  const timeout = ctx.synapse.binary_sensor({
    context: ctx.context,
    name: `${name} presence timeout`,
    is_on: false,
  })

  const { start, restart, setDuration, onEnd } = useTimer()

  // set timeout state when timer ends
  onEnd(() => timeout.is_on = true)

  // update state based on presenseSensors
  function getAreaOccupancy(state: AreaState) {
    const hasMotion = presenceSensors.some(sensor => sensor.state === 'on')
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
