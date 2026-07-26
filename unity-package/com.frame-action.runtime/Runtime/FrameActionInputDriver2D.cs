using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;

namespace FrameAction
{
    [DisallowMultipleComponent]
    [RequireComponent(typeof(FrameActionController2D))]
    public sealed class FrameActionInputDriver2D : MonoBehaviour, IFrameActionCommandSink
    {
        private sealed class ButtonBinding
        {
            public InputAction inputAction;
            public FrameActionData action;
            public Action<InputAction.CallbackContext> callback;
        }

        public FrameActionPlayer player;
        public FrameActionController2D controller;
        public FrameActionMotor2D motor;
        public bool acceptLocalInput = true;

        public float CurrentMoveAxis { get; private set; }
        public bool RunRequested { get; private set; }

        private readonly List<ButtonBinding> _buttonBindings = new List<ButtonBinding>();
        private InputAction _moveAction;
        private int _previousMoveDirection;
        private float _lastNegativeTap = float.NegativeInfinity;
        private float _lastPositiveTap = float.NegativeInfinity;
        private FrameActionProjectData _boundProject;

        private void Awake()
        {
            if (player == null) player = GetComponent<FrameActionPlayer>();
            if (controller == null) controller = GetComponent<FrameActionController2D>();
            if (motor == null) motor = GetComponent<FrameActionMotor2D>();
        }

        private void OnEnable()
        {
            if (player != null) player.ProjectLoaded += HandleProjectLoaded;
            RebuildBindings();
        }

        private void OnDisable()
        {
            if (player != null) player.ProjectLoaded -= HandleProjectLoaded;
            DisposeBindings();
            _boundProject = null;
            SubmitMoveAxis(0f);
        }

        private void Update()
        {
            FrameActionProjectData project = player?.Project;
            if (!ReferenceEquals(project, _boundProject)) RebuildBindings();
            FrameActionMotorSettings settings = project?.motor;
            if (!acceptLocalInput || settings == null || !settings.enableInput)
            {
                SubmitMoveAxis(0f);
                return;
            }

            float axis = ReadMoveAxis();
            SubmitMoveAxis(Mathf.Abs(axis) >= Mathf.Clamp(settings.inputDeadZone, 0f, 0.95f) ? Mathf.Clamp(axis, -1f, 1f) : 0f);
        }

        private float ReadMoveAxis()
        {
            if (_moveAction == null) return 0f;

            float axis = _moveAction.ReadValue<float>();
            Keyboard keyboard = Keyboard.current;
            if (keyboard == null) return axis;

            // Keep the generated InputAction as the primary source, but also read the
            // physical side-scroller keys directly. This makes local movement resilient
            // after domain reloads and when a dynamically-created composite has not yet
            // produced a value on its first input update.
            float keyboardAxis = 0f;
            if (keyboard.aKey.isPressed || keyboard.leftArrowKey.isPressed) keyboardAxis -= 1f;
            if (keyboard.dKey.isPressed || keyboard.rightArrowKey.isPressed) keyboardAxis += 1f;
            return Mathf.Abs(keyboardAxis) > Mathf.Abs(axis) ? keyboardAxis : axis;
        }

        public void RebuildBindings()
        {
            DisposeBindings();
            FrameActionProjectData project = player?.Project;
            _boundProject = project;
            if (project?.actions == null) return;

            HashSet<string> axisCodes = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < project.actions.Count; i++)
            {
                FrameActionData action = project.actions[i];
                if (action?.trigger == null) continue;
                string triggerType = action.trigger.type ?? "none";
                if (triggerType == "axisTap" || triggerType == "axisDoubleTap")
                {
                    if (!string.IsNullOrEmpty(action.trigger.code)) axisCodes.Add(action.trigger.code);
                    continue;
                }

                if (triggerType == "keyboardChord")
                {
                    string modifierPath = ResolveButtonPath("keyboard", action.trigger.code);
                    string buttonPath = ResolveButtonPath("keyboard", action.trigger.secondaryCode);
                    if (string.IsNullOrEmpty(modifierPath) || string.IsNullOrEmpty(buttonPath) || modifierPath == buttonPath) continue;
                    InputAction chordAction = new InputAction($"FrameAction/{action.id}", InputActionType.Button);
                    chordAction.AddCompositeBinding("ButtonWithOneModifier")
                        .With("Modifier", modifierPath)
                        .With("Button", buttonPath);
                    ButtonBinding chordBinding = new ButtonBinding { inputAction = chordAction, action = action };
                    chordBinding.callback = _ =>
                    {
                        if (acceptLocalInput && player?.Project?.motor?.enableInput == true) TriggerConfiguredAction(chordBinding.action);
                    };
                    chordAction.performed += chordBinding.callback;
                    chordAction.Enable();
                    _buttonBindings.Add(chordBinding);
                    continue;
                }

                string path = ResolveButtonPath(triggerType, action.trigger.code);
                if (string.IsNullOrEmpty(path)) continue;
                InputAction inputAction = new InputAction($"FrameAction/{action.id}", InputActionType.Button, path);
                ButtonBinding binding = new ButtonBinding { inputAction = inputAction, action = action };
                binding.callback = _ =>
                {
                    if (acceptLocalInput
                        && player?.Project?.motor?.enableInput == true
                        && !IsSuppressedByActiveChord(binding.action))
                    {
                        TriggerConfiguredAction(binding.action);
                    }
                };
                inputAction.performed += binding.callback;
                inputAction.Enable();
                _buttonBindings.Add(binding);
            }

            if (axisCodes.Count > 0)
            {
                _moveAction = new InputAction("FrameAction/Move", InputActionType.Value);
                foreach (string code in axisCodes) AddAxisBindings(_moveAction, code);
                _moveAction.AddBinding("<Gamepad>/leftStick/x");
                _moveAction.AddCompositeBinding("1DAxis")
                    .With("Negative", "<Gamepad>/dpad/left")
                    .With("Positive", "<Gamepad>/dpad/right");
                _moveAction.Enable();
            }
        }

        private void HandleProjectLoaded(FrameActionProjectData project)
        {
            if (isActiveAndEnabled) RebuildBindings();
        }

        public void SubmitMoveAxis(float axis)
        {
            CurrentMoveAxis = Mathf.Clamp(axis, -1f, 1f);
            if (motor != null) motor.SetMoveInput(CurrentMoveAxis);

            int direction = CurrentMoveAxis < 0f ? -1 : CurrentMoveAxis > 0f ? 1 : 0;
            if (direction != 0 && direction != _previousMoveDirection) HandleMoveStarted(direction);
            if (direction == 0 && _previousMoveDirection != 0) RunRequested = false;
            controller?.SetLocomotionIntent(CurrentMoveAxis, RunRequested);
            ApplyFacing(CurrentMoveAxis);
            _previousMoveDirection = direction;
        }

        public bool TriggerCustom(string code)
        {
            FrameActionData action = player?.FindActionByTrigger("custom", code);
            return action != null && TriggerConfiguredAction(action);
        }

        public bool TriggerAction(string actionId)
        {
            FrameActionData action = player?.FindAction(actionId);
            return action != null && TriggerConfiguredAction(action);
        }

        private bool TriggerConfiguredAction(FrameActionData action)
        {
            if (action == null || controller == null) return false;
            if (action.type == "jump" && motor != null && player?.Project?.motor?.enableMotor == true)
            {
                return motor.QueueJump(action);
            }
            if (action.type == "dropThrough" && motor != null && player?.Project?.motor?.enableMotor == true)
            {
                return motor.TryDropThrough(action);
            }
            return controller.RequestAction(action.id);
        }

        private bool IsSuppressedByActiveChord(FrameActionData action)
        {
            if (action?.trigger?.type != "keyboard" || string.IsNullOrEmpty(action.trigger.code)) return false;
            FrameActionProjectData project = player?.Project;
            if (project?.actions == null) return false;
            for (int i = 0; i < project.actions.Count; i++)
            {
                FrameActionTriggerData trigger = project.actions[i]?.trigger;
                if (trigger?.type != "keyboardChord" || trigger.secondaryCode != action.trigger.code) continue;
                string modifierPath = ResolveButtonPath("keyboard", trigger.code);
                if (!string.IsNullOrEmpty(modifierPath) && InputSystem.FindControl(modifierPath) is ButtonControl modifier && modifier.isPressed)
                {
                    return true;
                }
            }
            return false;
        }

        private void HandleMoveStarted(int direction)
        {
            float now = Time.unscaledTime;
            FrameActionData doubleTapAction = FindAxisAction("axisDoubleTap");
            float previousTap = direction < 0 ? _lastNegativeTap : _lastPositiveTap;
            bool isDoubleTap = doubleTapAction != null && now - previousTap <= Mathf.Max(0.05f, doubleTapAction.doubleTapWindow);
            FrameActionData requested = isDoubleTap ? doubleTapAction : FindAxisAction("axisTap");
            RunRequested = isDoubleTap;
            if (requested != null) controller?.RequestAction(requested.id);
            if (direction < 0) _lastNegativeTap = now; else _lastPositiveTap = now;
        }

        private FrameActionData FindAxisAction(string triggerType)
        {
            FrameActionProjectData project = player?.Project;
            if (project?.actions == null) return null;
            for (int i = 0; i < project.actions.Count; i++)
            {
                FrameActionData action = project.actions[i];
                if (action?.trigger != null && action.trigger.type == triggerType) return action;
            }
            return null;
        }

        private void ApplyFacing(float axis)
        {
            FrameActionMotorSettings settings = player?.Project?.motor;
            if (player == null
                || settings == null
                || !settings.autoFaceMovement
                || Mathf.Abs(axis) < 0.001f
                || controller != null && controller.IsLocomotionInputLocked)
            {
                return;
            }
            player.facingLeft = axis < 0f;
        }

        private void DisposeBindings()
        {
            for (int i = 0; i < _buttonBindings.Count; i++)
            {
                ButtonBinding binding = _buttonBindings[i];
                if (binding?.inputAction == null) continue;
                if (binding.callback != null) binding.inputAction.performed -= binding.callback;
                binding.inputAction.Disable();
                binding.inputAction.Dispose();
            }
            _buttonBindings.Clear();
            if (_moveAction != null)
            {
                _moveAction.Disable();
                _moveAction.Dispose();
                _moveAction = null;
            }
        }

        private static void AddAxisBindings(InputAction action, string code)
        {
            if (code == "A/D" || code == "A/D/LeftArrow/RightArrow")
            {
                action.AddCompositeBinding("1DAxis")
                    .With("Negative", "<Keyboard>/a")
                    .With("Positive", "<Keyboard>/d");
            }
            if (code == "LeftArrow/RightArrow" || code == "A/D/LeftArrow/RightArrow")
            {
                action.AddCompositeBinding("1DAxis")
                    .With("Negative", "<Keyboard>/leftArrow")
                    .With("Positive", "<Keyboard>/rightArrow");
            }
        }

        private static string ResolveButtonPath(string triggerType, string code)
        {
            if (triggerType == "mouse")
            {
                switch (code)
                {
                    case "Mouse0": return "<Mouse>/leftButton";
                    case "Mouse1": return "<Mouse>/rightButton";
                    case "Mouse2": return "<Mouse>/middleButton";
                    case "Mouse3": return "<Mouse>/backButton";
                    case "Mouse4": return "<Mouse>/forwardButton";
                    default: return null;
                }
            }
            if (triggerType != "keyboard") return null;
            switch (code)
            {
                case "Space": return "<Keyboard>/space";
                case "LeftShift": return "<Keyboard>/leftShift";
                case "LeftCtrl": return "<Keyboard>/leftCtrl";
                case "Escape": return "<Keyboard>/escape";
                case "Digit1": return "<Keyboard>/digit1";
                case "Digit2": return "<Keyboard>/digit2";
                case "Digit3": return "<Keyboard>/digit3";
                case "Digit4": return "<Keyboard>/digit4";
                case "Digit5": return "<Keyboard>/digit5";
                case "Digit6": return "<Keyboard>/digit6";
                case "Digit7": return "<Keyboard>/digit7";
                case "Digit8": return "<Keyboard>/digit8";
                case "Digit9": return "<Keyboard>/digit9";
                case "Digit0": return "<Keyboard>/digit0";
                default:
                    return !string.IsNullOrEmpty(code) && code.Length == 1 && char.IsLetter(code[0])
                        ? $"<Keyboard>/{char.ToLowerInvariant(code[0])}"
                        : null;
            }
        }
    }
}
