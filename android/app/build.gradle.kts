import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Подпись релиза. Ключ и пароль лежат рядом с проектом и в репозиторий
// не идут: без них собирается неподписанный APK, чего хватает для
// отладки, но не для установки на телефон.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val signingStore = rootProject.file(localProps.getProperty("signing.store") ?: "pastetalk-release.jks")

android {
    namespace = "ru.appswire.pastetalk"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.appswire.pastetalk"
        // Android 8: покрывает почти все живые телефоны, а требовать
        // свежую систему от человека, которому нужна одна кнопка, незачем.
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "2.7.1"
    }

    signingConfigs {
        create("release") {
            if (signingStore.exists()) {
                storeFile = signingStore
                storePassword = localProps.getProperty("signing.password") ?: ""
                keyAlias = localProps.getProperty("signing.alias") ?: "pastetalk"
                keyPassword = localProps.getProperty("signing.password") ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }
}

dependencies {
    // Ничего сверх Compose: сеть умеет HttpURLConnection, разбор JSON —
    // org.json, запись звука — MediaRecorder. Всё это уже в Android, а
    // каждая лишняя зависимость — лишний повод сборке сломаться через год.
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
}
