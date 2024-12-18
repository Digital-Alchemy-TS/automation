import type { ByIdProxy, PICK_ENTITY } from '@digital-alchemy/hass'
import type { Duration, UseTimerOutput } from '../helpers/timer.mjs'
import { InternalError, type TServiceParams } from '@digital-alchemy/core'

export interface SceneDef {
  name: string
  on: Array<() => void>
  off?: Array<() => void>
  icon?: string
  isDefault?: boolean
  timeout?: Duration | (() => Duration)
}
export type ActivateSceneCondition = () => boolean

type ParsedSceneMeta = Omit<SceneDef, 'timeout'> & { timeout: Duration }
type Scenes = Map<string, SceneDef>

export interface SceneControllerInput {
  ctx: TServiceParams
  name: string
  conditions?: ActivateSceneCondition[]
  definitions: SceneDef[]
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
interface SceneControllerOptions {
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
    onActivate,
    onInit,
    onOff,
    onUpdate,
  } = options

  const {
    ctx,
    name,
    conditions = [],
    definitions,
    off: defaultOff,
    setTimeout,
    triggers,
  } = input

  const scenes = new Map<string, SceneDef>()

  definitions.forEach(scene => scenes.set(scene.name, scene))

  if (scenes.size === 0)
    throw new Error(`[SCENE CONTROLLER] Error: No scene definitions.`)

  const state = ctx.synapse.sensor<{ state: 'active' | 'idle' }>({
    context: ctx.context,
    name: `${name} Scene State`,
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
    name: `${name} Scene Controller`,
    state: 'default',
    options: [...scenes.keys()] as const,
  })

  sceneUiControls({
    ctx,
    entityType: 'switch',
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

  function _getSceneDef(id: string) {
    const sceneMeta = scenes.get(id)

    if (!sceneMeta) {
      throw new InternalError(
        ctx.context,
        `[SCENE CONTROLLER][${name.toUpperCase()}][GET META]`,
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
  entityType: 'switch' | 'select'
  scenes: Scenes
  activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
  setScene: (name: string) => void
}

// handle ui - user inputs & ui state logic
function sceneUiControls(input: SceneUiControlsInput) {
  const { ctx, entityType, scenes, activeScene, setScene } = input
  const defaultSceneName = _getDefaultScene()

  function _generateUiControls() {
    if (entityType === 'switch')
      sceneSwitchUi({ ctx, scenes, activeScene, defaultSceneName, setScene })
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
  scenes: Scenes
  activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
  defaultSceneName: string
  setScene: (name: string) => void
}) {
  const { ctx, scenes, activeScene, defaultSceneName, setScene } = input
  const switches = [...scenes.entries()].reduce(
    (switches, [id, sceneMeta]) => {
      switches.push(
        generateSwitch({
          ctx,
          name: id,
          icon: sceneMeta.icon,
          isDefault: sceneMeta.isDefault,
          activeScene,
          defaultSceneName,
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
  input: Pick<SceneDef, 'name' | 'isDefault' | 'icon'> & {
    ctx: Pick<TServiceParams, 'context' | 'synapse'>
    activeScene: ByIdProxy<PICK_ENTITY<'sensor'>>
    defaultSceneName: string
    setScene: (name: string) => void
  },
) {
  const {
    ctx,
    name,
    icon = 'mdi:lightbulb-group',
    isDefault,
    activeScene,
    defaultSceneName,
    setScene,
  } = input

  const switchEntity = ctx.synapse.switch({
    name,
    icon,
    device_class: 'switch',
    context: ctx.context,
    is_on: {
      onUpdate: [activeScene],
      current: () => {
        if (activeScene.state === name)
          return true

        if (activeScene.state !== name)
          return false
      },
    },
    turn_on: () => setScene(name),
    turn_off: () => {
      if (!isDefault)
        setScene(defaultSceneName)
    },
  })

  return switchEntity
}
