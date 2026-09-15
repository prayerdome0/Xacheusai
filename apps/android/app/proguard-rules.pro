# Xacheus keeps release builds unminified for auditability (see build.gradle.kts).
# If you enable minification, keep OkHttp/Kotlin metadata intact.

-dontwarn okhttp3.**
-dontwarn okio.**
-keep class ai.xacheus.app.** { *; }
-keepattributes *Annotation*, InnerClasses
