using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace FrameAction
{
    [Serializable]
    public sealed class FrameActionProjectData
    {
        public string format;
        public int version;
        public string projectKind = "character";
        public int tickRate = 600;
        public string characterName;
        public float pixelsPerUnit = 100f;
        public string sourceFacing = "right";
        public string groundIdleId = "ground-idle";
        public string airIdleId = "air-idle";
        public FrameActionMotorSettings motor = new FrameActionMotorSettings();
        public FrameActionCameraFollowSettings cameraFollow = new FrameActionCameraFollowSettings();
        public FrameActionUnityCharacterSettings unityCharacter = new FrameActionUnityCharacterSettings();
        public FrameActionEnemyBehaviorSettings enemyBehavior = new FrameActionEnemyBehaviorSettings();
        public List<FrameActionData> actions = new List<FrameActionData>();
        public List<FrameAssetManifestEntry> assets = new List<FrameAssetManifestEntry>();
    }

    [Serializable]
    public sealed class FrameActionEnemyBehaviorSettings
    {
        public bool playGroundIdleOnEnable = true;
        public bool returnToIdleOnComplete;
        public bool enabled = true;
        public float tickIntervalSeconds = 0.1f;
        public FrameActionEnemyMovementSettings movement = new FrameActionEnemyMovementSettings();
        public string rootNodeId = "";
        public List<FrameActionEnemyBehaviorNodeData> nodes = new List<FrameActionEnemyBehaviorNodeData>();
    }

    [Serializable]
    public sealed class FrameActionEnemyMovementSettings
    {
        public bool enabled = true;
        public string targetTag = "Player";
        public float detectionRange = 8f;
        public float loseTargetRange = 12f;
        public float verticalTolerance = 2f;
        public float patrolDistance = 3f;
        public float patrolSpeed = 1.5f;
        public float chaseSpeed = 3f;
        public float acceleration = 30f;
        public float stopDistance = 1f;
        public float blockedWaitSeconds = 1.2f;
        public float turnCooldownSeconds = 0.15f;
        public float wallCheckDistance = 0.12f;
        public float ledgeCheckForwardDistance = 0.25f;
        public float ledgeCheckDownDistance = 0.65f;
        public float groundCheckDistance = 0.08f;
        public string environmentLayerName = "Ground";
        public float gravityScale = 3f;
        public float maxFallSpeed = 18f;
    }

    [Serializable]
    public sealed class FrameActionEnemyBehaviorNodeData
    {
        public string id;
        public string parentId;
        public int order;
        public string name;
        public string type;
        public string conditionKey;
        public string comparison = "isTrue";
        public float numberValue;
        public string stringValue;
        public string actionId;
        public bool waitUntilComplete = true;
        public bool ignoreSkillCooldown;
        public float durationSeconds = 0.5f;
        public string taskKey;
        public float positionX;
        public float positionY;
    }

    [Serializable]
    public sealed class FrameActionCameraFollowSettings
    {
        public bool enabled = true;
        public bool followHorizontal = true;
        public bool followVertical = true;
        public float smoothTime = 0.15f;
        public float offsetX;
        public float offsetY = 1.5f;
        public float orthographicSize = 5f;
        public bool constrainToMap = true;
        public float edgePaddingX = 0.25f;
        public float edgePaddingY = 0.25f;
    }

    [Serializable]
    public sealed class FrameActionUnityCharacterSettings
    {
        public string prefabPath = "";
        public string actorLayerName = "";
        public bool collideWithOtherActors;
        public string colliderShape = "capsule";
        public float colliderWidth = 0.6f;
        public float colliderHeight = 1.2f;
        public float colliderOffsetX;
        public float colliderOffsetY = 0.6f;
        public string hurtboxShape = "capsule";
        public float hurtboxWidth = 0.55f;
        public float hurtboxHeight = 1.1f;
        public float hurtboxOffsetX;
        public float hurtboxOffsetY = 0.6f;
        public float rigidbodyMass = 1f;
    }

    [Serializable]
    public sealed class FrameActionMotorSettings
    {
        public bool enableInput = true;
        public bool enableMotor = true;
        public bool autoFaceMovement = true;
        public float groundAcceleration = 40f;
        public float groundDeceleration = 55f;
        public float airControl = 0.55f;
        public float gravityScale = 3f;
        public float maxFallSpeed = 18f;
        public float coyoteTime = 0.1f;
        public float jumpBufferTime = 0.12f;
        public float groundCheckDistance = 0.08f;
        public string groundLayerName = "Ground";
        public float inputDeadZone = 0.15f;
    }

    [Serializable]
    public sealed class FrameActionData
    {
        public string id;
        public string name;
        public string type;
        public bool loop;
        public bool acceptMovementInput = true;
        public bool acceptJumpInput;
        public int comboCount = 1;
        public float comboWindow = 0.12f;
        public float repeatWindow = 0.28f;
        public bool allowLastRepeat;
        public float doubleTapWindow = 0.28f;
        public float movementSpeed = 4f;
        public FrameActionEnemySkillSettings enemySkill;
        public FrameActionTriggerData trigger = new FrameActionTriggerData();
        public Dictionary<string, string> transitions = new Dictionary<string, string>();
        public List<FrameActionSegmentData> segments = new List<FrameActionSegmentData>();
    }

    [Serializable]
    public sealed class FrameActionEnemySkillSettings
    {
        public float cooldownSeconds = 1.5f;
        public float minRange;
        public float maxRange = 1.5f;
        public float selectionWeight = 1f;
        public bool lockMovement = true;
        public bool lockFacing = true;
    }

    [Serializable]
    public sealed class FrameActionSegmentData
    {
        public string id;
        public string name;
        public int fps = 12;
        public int frameCount = 8;
        public int sheetColumns = 5;
        public int sheetSpacing;
        public int sheetPadding;
        public int cellWidth = 500;
        public int cellHeight = 500;
        public float pixelsPerUnit = 160f;
        public float pivotX = 230f;
        public float pivotY = 110f;
        public float jumpHeight = 2.4f;
        public string spriteSheetAssetId;
        public List<FrameAnimationFrameData> frames = new List<FrameAnimationFrameData>();
        public List<FrameTimelineTrackData> tracks = new List<FrameTimelineTrackData>();
    }

    [Serializable]
    public sealed class FrameAnimationFrameData
    {
        public string id;
        public string name;
        public string assetId;
        public int durationTicks = 1;
    }

    [Serializable]
    public sealed class FrameTimelineTrackData
    {
        public string id;
        public string name;
        public string kind;
        public List<FrameTimelineEventData> events = new List<FrameTimelineEventData>();
    }

    [Serializable]
    public sealed class FrameTimelineEventData
    {
        public string id;
        public string name;
        public string type;
        public int startTick;
        public int durationTicks;
        public string triggerMode = "once";
        public string activeDurationMode = "fixed";
        public int repeatIntervalTicks = 60;

        [JsonProperty("params")]
        public JObject parameters = new JObject();

        public float GetFloat(string key, float fallback = 0f)
        {
            JToken value = parameters?[key];
            return value != null && value.Type != JTokenType.Null ? value.Value<float>() : fallback;
        }

        public string GetString(string key, string fallback = "")
        {
            JToken value = parameters?[key];
            return value != null && value.Type != JTokenType.Null ? value.Value<string>() : fallback;
        }
    }

    [Serializable]
    public sealed class FrameActionTriggerData
    {
        public string type = "none";
        public string code = "";
        public string secondaryCode = "";
    }

    [Serializable]
    public sealed class FrameAssetManifestEntry
    {
        public string id;
        public string name;
        public string kind;
        public string usage;
        public string path;
    }
}
