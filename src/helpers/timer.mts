/* eslint-disable no-console */

// Like Object.entries, but returns a more specific type
// reference: https://news.ycombinator.com/item?id=36457557

// expands object types one level deep
type ObjectEntry<T> = {
  [K in Exclude<keyof T, undefined>]: [K, T[K]];
}[Exclude<keyof T, undefined>]

export const objectEntries = Object.entries as <T>(o: T) => ObjectEntry<T>[]

export const objectKeys = Object.keys as <T>(obj: T) => Array<keyof T>

export interface Duration {
  hours?: number
  minutes?: number
  seconds?: number
}

export type UseTimerOutput = ReturnType<typeof useTimer>

export function useTimer() {
  let startTime = 0
  let endTime = 0
  let duration = 0
  let timeoutId: NodeJS.Timeout | null = null
  let onEndAction: () => void

  function start(cb?: () => void) {
    console.log('[TIMER] Starting Timer!')

    startTime = Date.now()
    endTime = startTime + duration

    timeoutId = setTimeout(() => {
      console.log('[TIMER] Times up!')

      // end callback
      _onEnd()

      _clearTimer()
    }, duration)

    // start callback
    if (cb)
      cb()
  }

  function stop() {
    if (_getRemainingTime() <= 0 || !timeoutId)
      return

    _clearTimer()
    console.log('[TIMER] Stopping Timer!')
  }

  function restart() {
    console.log('[TIMER] Restarting Timer!')
    _clearTimer()
    start()
  }

  function onEnd(cb: () => void) {
    onEndAction = cb
  }

  /**
   * Set the timer duration
   * @param timerDuration number (seconds)
   */
  function setDuration(timerDuration: Duration) {
    const timeMultiplier: Record<keyof Duration, number> = {
      hours: 1000 * 60 * 60,
      minutes: 1000 * 60,
      seconds: 1000,
    }

    const normalizedDuration = objectEntries(timerDuration).reduce(
      (total, [k, v]) => (total += timeMultiplier[k] * v),
      0,
    )

    console.log(
      `[TIMER] Setting duration to ${normalizedDuration}. Input={${JSON.stringify(timerDuration)}}`,
    )
    duration = normalizedDuration
  }

  function hasTimeLeft() {
    return _getRemainingTime() > 0
  }

  function _getRemainingTime() {
    return endTime - Date.now()
  }

  function _clearTimer() {
    clearTimeout(timeoutId)
    timeoutId = null
  }

  // timers reached 0 callback
  function _onEnd() {
    if (onEndAction)
      onEndAction()
  }

  return {
    start,
    stop,
    restart,
    onEnd,
    hasTimeLeft,
    setDuration,
  }
}
