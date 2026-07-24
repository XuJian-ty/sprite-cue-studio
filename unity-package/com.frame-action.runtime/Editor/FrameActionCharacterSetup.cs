using UnityEditor;
using UnityEngine;

namespace FrameAction.Editor
{
    public static class FrameActionCharacterSetup
    {
        [MenuItem("Tools/Frame Action/Setup Selected Character", false, 20)]
        public static void SetupSelectedCharacter()
        {
            GameObject selected = Selection.activeGameObject;
            if (selected == null) return;

            FrameActionPlayer player = selected.GetComponent<FrameActionPlayer>();
            bool playerCreated = player == null;
            if (playerCreated) player = Undo.AddComponent<FrameActionPlayer>(selected);
            FrameActionController2D controller = selected.GetComponent<FrameActionController2D>();
            if (controller == null) controller = Undo.AddComponent<FrameActionController2D>(selected);
            FrameActionBuiltinEventHandler2D handler = selected.GetComponent<FrameActionBuiltinEventHandler2D>();
            if (handler == null) handler = Undo.AddComponent<FrameActionBuiltinEventHandler2D>(selected);
            FrameActionMotor2D motor = selected.GetComponent<FrameActionMotor2D>();
            if (motor == null) motor = Undo.AddComponent<FrameActionMotor2D>(selected);
            FrameActionInputDriver2D inputDriver = selected.GetComponent<FrameActionInputDriver2D>();
            if (inputDriver == null) inputDriver = Undo.AddComponent<FrameActionInputDriver2D>(selected);
            FrameActionCameraFollow2D cameraFollow = selected.GetComponent<FrameActionCameraFollow2D>();
            if (cameraFollow == null) cameraFollow = Undo.AddComponent<FrameActionCameraFollow2D>(selected);

            player.spriteRenderer = player.spriteRenderer != null ? player.spriteRenderer : selected.GetComponentInChildren<SpriteRenderer>(true);
            player.visualRoot = player.visualRoot != null
                ? player.visualRoot
                : player.spriteRenderer != null ? player.spriteRenderer.transform : selected.transform;
            if (playerCreated) player.playOnEnable = false;

            controller.player = player;
            controller.playIdleOnEnable = true;
            motor.player = player;
            motor.controller = controller;
            motor.body = selected.GetComponent<Rigidbody2D>();
            motor.bodyCollider = selected.GetComponent<Collider2D>();
            inputDriver.player = player;
            inputDriver.controller = controller;
            inputDriver.motor = motor;
            handler.player = player;
            handler.ownerBody = handler.ownerBody != null ? handler.ownerBody : selected.GetComponent<Rigidbody2D>();
            handler.previewCamera = handler.previewCamera != null ? handler.previewCamera : Camera.main;
            cameraFollow.followTarget = selected.transform;
            handler.cameraReceiverBehaviour = cameraFollow;

            if (player.characterAsset == null)
            {
                string[] guids = AssetDatabase.FindAssets("t:FrameActionCharacterAsset", new[] { "Assets/FrameActionGenerated" });
                if (guids.Length == 1)
                {
                    player.characterAsset = AssetDatabase.LoadAssetAtPath<FrameActionCharacterAsset>(AssetDatabase.GUIDToAssetPath(guids[0]));
                }
            }

            EditorUtility.SetDirty(player);
            EditorUtility.SetDirty(controller);
            EditorUtility.SetDirty(handler);
            EditorUtility.SetDirty(motor);
            EditorUtility.SetDirty(inputDriver);
            EditorUtility.SetDirty(cameraFollow);
            Debug.Log("[Frame Action] Selected character is ready. Assign Character Asset and a target provider/default target when needed.", selected);
        }

        [MenuItem("Tools/Frame Action/Setup Selected Character", true)]
        private static bool ValidateSetupSelectedCharacter()
        {
            return Selection.activeGameObject != null;
        }
    }
}
