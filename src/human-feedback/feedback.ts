import { Agentic } from '@/agentic'
import { BaseTask } from '@/task'

import { HumanFeedbackMechanismCLI } from './cli'

/**
 * Actions the user can take in the feedback selection prompt.
 */
export const HumanFeedbackUserActions = {
  Accept: 'accept',
  Edit: 'edit',
  Decline: 'decline',
  Select: 'select',
  Exit: 'exit'
} as const

export type HumanFeedbackUserActions =
  (typeof HumanFeedbackUserActions)[keyof typeof HumanFeedbackUserActions]

export const HumanFeedbackUserActionMessages: Record<
  HumanFeedbackUserActions,
  string
> = {
  [HumanFeedbackUserActions.Accept]: 'Accept the output',
  [HumanFeedbackUserActions.Edit]: 'Edit the output',
  [HumanFeedbackUserActions.Decline]: 'Decline the output',
  [HumanFeedbackUserActions.Select]: 'Select outputs to keep',
  [HumanFeedbackUserActions.Exit]: 'Exit'
}

/**
 * Available types of human feedback.
 */
export type HumanFeedbackType = 'confirm' | 'selectOne' | 'selectN'

type HumanFeedbackMechanismConstructor<T extends HumanFeedbackType> = new (
  ...args: any[]
) => HumanFeedbackMechanism<T>

/**
 * Options for human feedback.
 */
export type HumanFeedbackOptions<T extends HumanFeedbackType> = {
  /**
   * What type of feedback to request.
   */
  type?: T

  /**
   * Whether the user can bail out of the feedback loop.
   */
  bail?: boolean

  /**
   * Whether the user can edit the output.
   */
  editing?: boolean

  /**
   * Whether the user can add free-form text annotations.
   */
  annotations?: boolean

  /**
   * The human feedback mechanism to use for this task.
   */
  mechanism?: HumanFeedbackMechanismConstructor<T>
}

export interface BaseHumanFeedbackMetadata {
  /**
   * Edited output by the user (if applicable).
   */
  editedOutput?: string

  /**
   * Annotation left by the user (if applicable).
   */
  annotation?: string
}

export interface HumanFeedbackConfirmMetadata
  extends BaseHumanFeedbackMetadata {
  /**
   * The type of feedback requested.
   */
  type: 'confirm'

  /**
   * Whether the user accepted the output.
   */
  accepted: boolean
}

export interface HumanFeedbackSelectOneMetadata
  extends BaseHumanFeedbackMetadata {
  /**
   * The type of feedback requested.
   */
  type: 'selectOne'

  /**
   * The selected output.
   */
  chosen: any
}

export interface HumanFeedbackSelectNMetadata
  extends BaseHumanFeedbackMetadata {
  /**
   * The type of feedback requested.
   */
  type: 'selectN'

  /**
   * The selected outputs.
   */
  selected: any[]
}

export type FeedbackTypeToMetadata<T extends HumanFeedbackType> =
  T extends 'confirm'
    ? HumanFeedbackConfirmMetadata
    : T extends 'selectOne'
    ? HumanFeedbackSelectOneMetadata
    : HumanFeedbackSelectNMetadata

export abstract class HumanFeedbackMechanism<T extends HumanFeedbackType> {
  protected _agentic: Agentic

  protected _options: Required<HumanFeedbackOptions<T>>

  constructor({
    agentic,
    options
  }: {
    agentic: Agentic
    options: Required<HumanFeedbackOptions<T>>
  }) {
    this._agentic = agentic
    this._options = options
  }

  protected abstract selectOne(response: any): Promise<any>

  protected abstract selectN(response: any): Promise<any>

  protected abstract annotate(): Promise<string>

  protected abstract edit(output: string): Promise<string>

  protected abstract askUser(
    message: string,
    choices: HumanFeedbackUserActions[]
  ): Promise<HumanFeedbackUserActions>

  public async interact(response: any): Promise<FeedbackTypeToMetadata<T>> {
    const stringified = JSON.stringify(response, null, 2)
    const msg = [
      'The following output was generated:',
      '```',
      stringified,
      '```',
      'What would you like to do?'
    ].join('\n')

    const choices: HumanFeedbackUserActions[] = []
    if (
      this._options.type === 'selectN' ||
      this._options.type === 'selectOne'
    ) {
      choices.push(HumanFeedbackUserActions.Select)
    } else {
      // Case: confirm
      choices.push(HumanFeedbackUserActions.Accept)
      choices.push(HumanFeedbackUserActions.Decline)
    }

    if (this._options.editing) {
      choices.push(HumanFeedbackUserActions.Edit)
    }

    if (this._options.bail) {
      choices.push(HumanFeedbackUserActions.Exit)
    }

    const choice =
      choices.length === 1
        ? HumanFeedbackUserActions.Select
        : await this.askUser(msg, choices)

    const feedback: Record<string, any> = {}

    switch (choice) {
      case HumanFeedbackUserActions.Accept:
        feedback.accepted = true
        break

      case HumanFeedbackUserActions.Edit: {
        const editedOutput = await this.edit(stringified)
        feedback.editedOutput = editedOutput
        break
      }

      case HumanFeedbackUserActions.Decline:
        feedback.accepted = false
        break

      case HumanFeedbackUserActions.Select:
        if (this._options.type === 'selectN') {
          feedback.selected = await this.selectN(response)
        } else if (this._options.type === 'selectOne') {
          feedback.chosen = await this.selectOne(response)
        }

        break

      case HumanFeedbackUserActions.Exit:
        throw new Error('Exiting...')

      default:
        throw new Error(`Unexpected choice: ${choice}`)
    }

    if (this._options.annotations) {
      const annotation = await this.annotate()
      if (annotation) {
        feedback.annotation = annotation
      }
    }

    return feedback as FeedbackTypeToMetadata<T>
  }
}

export function withHumanFeedback<T, U, V extends HumanFeedbackType>(
  task: BaseTask<T, U>,
  options: HumanFeedbackOptions<V> = {}
) {
  task = task.clone()

  // Default options defined at the instance level
  const instanceDefaults = task.agentic.humanFeedbackDefaults

  // Use Object.assign to merge the options, instance defaults, and hard-coded defaults
  const finalOptions: HumanFeedbackOptions<V> = Object.assign(
    {
      type: 'confirm',
      bail: false,
      editing: false,
      annotations: false,
      mechanism: HumanFeedbackMechanismCLI
    },
    // Defaults from the instance:
    instanceDefaults,
    // User-provided options (override instance defaults):
    options
  )

  if (!finalOptions.mechanism) {
    throw new Error(
      'No feedback mechanism provided. Please provide a feedback mechanism to use.'
    )
  }

  const feedbackMechanism = new finalOptions.mechanism({
    agentic: task.agentic,
    options: finalOptions
  })

  const originalCall = task.callWithMetadata.bind(task)

  task.callWithMetadata = async function (input?: T) {
    const response = await originalCall(input)

    const feedback = await feedbackMechanism.interact(response.result)

    response.metadata = { ...response.metadata, feedback }

    return response
  }

  return task
}
