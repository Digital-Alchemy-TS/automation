import type { ByIdProxy, PICK_ENTITY } from '@digital-alchemy/hass'
import { objectEntries, type Duration, type UseTimerOutput } from '../helpers/timer.mjs'
import { InternalError, type TServiceParams } from '@digital-alchemy/core'

export interface SceneDef {
  id: string
  friendlyName?: string
  on: Array<() => void>
  off?: Array<() => void>
  icon?: string
  isDefault?: boolean
  timeout?: Duration | (() => Duration)
  // circadian?: 
}
export type ActivateSceneCondition = () => boolean

type ParsedSceneMeta = Omit<SceneDef, 'timeout'> & { timeout: Duration }
type Scenes = Map<string, SceneDef>

export interface SceneControllerInput {
  ctx: TServiceParams
  id: string
  areaName?: string
  conditions?: ActivateSceneCondition[]
  definitions: Record<string, SceneDef>
  /**
   * Default functiton to turn off scenes.
   * An off function in a scene definition will be used instead of this if defined.
   * @returns
   */
  off: () => void
  setTimeout?: UseTimerOutput['setDuration']
  triggers?: ByIdProxy<PICK_ENTITY>[]
}

// overkill?
export interface SceneControllerOptions {
  // ui controls for user manually switching scenes. default=switch
  controls?:
  // | 'select'  not implemented yet
  | 'switch'
  | ((input: Pick<SceneUiControlsInput, 'setScene' | 'activeScene'>) => void)
  /** on activate hook */
  onActivate?: (sceneMeta: ParsedSceneMeta) => void
  /** on init hook */
  onInit?: (sceneMeta: ParsedSceneMeta) => void
  /** on off hook */
  onOff?: (sceneMeta: ParsedSceneMeta) => void
  /** on update hook */
  onUpdate?: (sceneMeta: ParsedSceneMeta) => void
}

export function sceneController(
  input: SceneControllerInput,
  options: SceneControllerOptions = {},
) {
  const {
    controls = 'switch',
    onActivate,
    onInit,
    onOff,
    onUpdate,
  } = options

  const {
    ctx,
    id,
    areaName = id,
    conditions = [],
    definitions,
    off: defaultOff,
    setTimeout,
    triggers,
  } = input

  const scenes = _generateScenes()

  const state = ctx.synapse.sensor<{ state: 'active' | 'idle' }>({
    context: ctx.context,
    name: `${areaName} Scene State`,
    state: {
      onUpdate: triggers,
      current: () => {
        const conditionsMet = conditions.every(c => c())

        if (!conditionsMet) {
          ctx.logger.info(`[SCENE CONTROLLER][ACTIVATE] Conditions not met.`)
          return 'idle'
        }

        return 'active'
      },
    },
    options: ['active', 'idle'] as const,
  })

  const activeScene = ctx.synapse.sensor<{ state: string }>({
    context: ctx.context,
    name: `${id} Scene Controller`,
    state: 'default',
    options: [...scenes.keys()] as const,
  })

  sceneUiControls({
    ctx,
    areaName,
    controls,
    scenes,
    // @ts-expect-error - not sure how to properly type a synapse sensor vs hass sensor
    activeScene,
    setScene,
  })

  function init() {
    state.onUpdate((next, prev) => {
      if (next.state === prev.state)
        return

      if (next.state === 'active')
        activate()

      if (next.state === 'idle')
        off()
    })

    activeScene.onUpdate((next) => {
      const sceneDef = _getSceneDef(next.state as string)
      setTimeout(sceneDef.timeout)

      if (state.state === 'active')
        activate()

      // on update hook
      if (onUpdate)
        onUpdate(sceneDef)
    })

    // on init hook
    if (onInit)
      onInit(_getSceneDef(activeScene.state))
  }

  function activate() {
    const sceneMeta = _getSceneDef(activeScene.state)

    ctx.logger.info('[SCENE CONTROLLER] Activating scene:', activeScene.state)

    // on activate hook
    if (onActivate)
      onActivate(sceneMeta)

    for (const callback of sceneMeta.on) callback()
  }

  function off() {
    const sceneMeta = _getSceneDef(activeScene.state)

    ctx.logger.info('[SCENE CONTROLLER] Turning off scene:', activeScene.state)

    // on off hook
    if (onOff)
      onOff(sceneMeta)

    // prefer off methods defined in scene meta
    if (sceneMeta?.off) {
      for (const callback of sceneMeta.off) callback()
      return
    }

    // otherwise use the default off
    defaultOff()
  }

  function setScene(id: string) {
    activeScene.state = id
  }

  function _generateScenes() {
    const scenes = new Map<string, SceneDef>()

    objectEntries(definitions).forEach(([id, def]) => scenes.set(id, def))

    if (scenes.size === 0) {

      throw new InternalError(
        ctx.context,
        `[SCENE CONTROLLER][${id.toUpperCase()}]`,
        'No scene definitions.')
    }

    return scenes
  }

  function _getSceneDef(id: string) {
    const sceneMeta = scenes.get(id)

    if (!sceneMeta) {
      throw new InternalError(
        ctx.context,
        `[SCENE CONTROLLER][${id.toUpperCase()}][GET META]`,
        `Scene meta does not exist for: ${activeScene.state}`,
      )
    }

    const parsedMeta
      = typeof sceneMeta.timeout === 'function'
        ? { ...sceneMeta, timeout: sceneMeta.timeout() }
        : (sceneMeta as ParsedSceneMeta)

    return parsedMeta
  }

  return {
    activate,
    off,
    init,
  }
}

interface SceneUiControlsInput {
  ctx: TServiceParams
  areaName: string
  // ui controls for user manually switching scenes. default=switch
  controls?:
  | 'switch'
  // | 'select'  not implemented yet
  | ((input: { ctx: TServiceParams } & Pick<
    SceneUiControlsInput,
    'setScene' | 'activeScene'
  >) => void)
  scenes: Scenes
  activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
  setScene: (name: string) => void
}

// handle ui - user inputs & ui state logic
function sceneUiControls(input: SceneUiControlsInput) {
  const { ctx, areaName, controls, scenes, activeScene, setScene } = input

  const defaultSceneId = _getDefaultScene()

  function _generateUiControls() {
    if (typeof controls === 'function') {
      controls({ ctx, setScene, activeScene })
      return
    }

    if (controls === 'switch')
      sceneSwitchUi({ ctx, areaName, scenes, activeScene, defaultSceneId, setScene })


    // TODO: add select control
  }

  function _getDefaultScene() {
    let defaultScene: string

    for (const [k, v] of scenes) {
      if (!v?.isDefault)
        continue

      defaultScene = k
    }

    // if no defined default, use the first one & set isDefault true
    if (!defaultScene) {
      defaultScene = scenes.keys().next().value
      scenes.set(defaultScene, { ...scenes.get(defaultScene), isDefault: true })
    }

    return defaultScene
  }

  _generateUiControls()
}

function sceneSwitchUi(input: {
  ctx: Pick<TServiceParams, 'context' | 'synapse' | 'hass'>
  areaName: string
  scenes: Scenes
  activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
  defaultSceneId: string
  setScene: (name: string) => void
}) {
  const { ctx, areaName, scenes, activeScene, defaultSceneId, setScene } = input

  const switches = [...scenes.entries()].reduce(
    (switches, [id, sceneMeta]) => {
      switches.push(
        generateSwitch({
          ctx,
          id,
          sceneName: `${areaName} ${sceneMeta?.friendlyName ?? id}`,
          icon: sceneMeta.icon,
          isDefault: sceneMeta.isDefault,
          activeScene,
          defaultSceneId: defaultSceneId,
          setScene,
        }),
      )

      return switches
    },
    [] as ReturnType<typeof generateSwitch>[],
  )

  return switches
}

function generateSwitch(
  input: Pick<SceneDef, 'id' | 'isDefault' | 'icon'> & {
    ctx: Pick<TServiceParams, 'context' | 'synapse'>
    sceneName: string
    activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
    defaultSceneId: string
    setScene: (name: string) => void
  },
) {
  const {
    ctx,
    id,
    sceneName,
    icon = 'mdi:lightbulb-group',
    isDefault,
    activeScene,
    defaultSceneId,
    setScene,
  } = input

  const switchEntity = ctx.synapse.switch({
    name: `${sceneName} Switch`,
    icon,
    device_class: 'switch',
    context: ctx.context,
    is_on: {
      onUpdate: [activeScene],
      current: () => activeScene.state === id,
    },
    turn_on: () => setScene(id),
    turn_off: () => {
      if (!isDefault)
        setScene(defaultSceneId)
    },
  })

  return switchEntity
}
