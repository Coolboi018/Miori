import AsyncStorage from '@react-native-async-storage/async-storage';
(async () => {
  await AsyncStorage.setItem('foo', 'bar');
  console.log('read:', await AsyncStorage.getItem('foo'));
})();