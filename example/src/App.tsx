import * as React from 'react';

import { StyleSheet, View, Text, TextInput, Button } from 'react-native';
import { ClientBuilder } from '@unomed/react-native-matrix-sdk';
import { inspectHomeserverLogin } from './homeserver-login';

export default function App() {
  const [homeserver, setHomeserver] = React.useState('https://matrix.org');
  const [status, setStatus] = React.useState('');

  const updateHomeserverLoginDetails = React.useCallback(async () => {
    if (!homeserver.length) {
      setStatus('');
      return;
    }

    try {
      setStatus(await inspectHomeserverLogin(homeserver, new ClientBuilder()));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [homeserver]);

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header">Matrix SDK capability smoke test</Text>
      <TextInput
        accessibilityLabel="Homeserver URL"
        autoCapitalize="none"
        autoCorrect={false}
        value={homeserver}
        onChangeText={setHomeserver}
      />
      <Button
        title="Inspect login capabilities"
        onPress={updateHomeserverLoginDetails}
      />
      <Text accessibilityLabel="Login capability result">{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
